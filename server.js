const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json({ limit: '10mb' }));

const WORK_DIR = '/tmp/renders';
const OUTPUT_DIR = '/app/outputs';

[WORK_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Helper: agrega confirm=t a cualquier URL de Google Drive ────────────────
function gdriveConfirm(u) {
  if ((u.includes('drive.google.com') || u.includes('drive.usercontent.google.com')) && !u.includes('confirm=')) {
    return u + (u.includes('?') ? '&' : '?') + 'confirm=t';
  }
  return u;
}

// ─── Helper: descargar archivo siguiendo todos los redirects ──────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    function get(currentUrl, redirectCount) {
      if (redirectCount === undefined) redirectCount = 0;
      if (redirectCount > 15) return reject(new Error('Too many redirects'));

      // Aplicar confirm=t en CADA paso del chain (no solo la URL inicial)
      currentUrl = gdriveConfirm(currentUrl);

      const protocol = currentUrl.startsWith('https') ? https : http;
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; FFmpegRenderer/1.0)',
          'Accept': '*/*'
        }
      };

      protocol.get(currentUrl, options, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          var redirectUrl = res.headers.location;
          if (redirectUrl.startsWith('/')) {
            var parsed = new URL(currentUrl);
            redirectUrl = parsed.protocol + '//' + parsed.host + redirectUrl;
          }
          return get(redirectUrl, redirectCount + 1);
        } else if (res.statusCode !== 200) {
          file.destroy();
          reject(new Error('Download failed: ' + res.statusCode + ' for ' + currentUrl));
        } else {
          // Si Google devuelve HTML es la página de confirmación — el confirm=t no funcionó
          const ct = res.headers['content-type'] || '';
          if (ct.includes('text/html')) {
            res.resume();
            file.destroy();
            return reject(new Error('Google Drive devolvio pagina HTML en vez del archivo. URL: ' + currentUrl));
          }
          res.pipe(file);
          file.on('finish', function() { file.close(); resolve(dest); });
          file.on('error', reject);
        }
      }).on('error', function(err) {
        file.destroy();
        reject(err);
      });
    }

    get(url, 0);
  });
}

// ─── Helper: ejecutar FFmpeg como Promise ─────────────────────────────────────
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = 'ffmpeg -y ' + args;
    console.log('[FFmpeg]', cmd.substring(0, 200));
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 1800000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[FFmpeg error]', stderr.slice(-2000));
        reject(new Error(stderr.slice(-500)));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ─── Limpiar directorio de trabajo ────────────────────────────────────────────
function cleanup(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ─── POST /render ─────────────────────────────────────────────────────────────
app.post('/render', async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const { source } = req.body;
    if (!source || !source.elements) {
      return res.status(400).json({ error: 'Missing source.elements' });
    }

    const width = source.width || 1920;
    const height = source.height || 1080;
    const elements = source.elements;

    // role: 'music' distingue la cama musical de la narración. Sin role -> narración (compatible con payloads existentes)
    const audioElements = elements.filter(e => e.type === 'audio' && e.role !== 'music');
    const musicElements = elements.filter(e => e.type === 'audio' && e.role === 'music');
    const videoElements = elements.filter(e => e.type === 'video');
    console.log('[' + jobId + '] Audios: ' + audioElements.length + ', Musica: ' + musicElements.length + ', Videos: ' + videoElements.length);

    // 1. Descargar audios
    const audioPaths = [];
    for (let i = 0; i < audioElements.length; i++) {
      const audioPath = path.join(jobDir, 'audio_' + i + '.mp3');
      console.log('[' + jobId + '] Descargando audio ' + (i + 1) + '/' + audioElements.length);
      await downloadFile(audioElements[i].source, audioPath);
      audioPaths.push(audioPath);
    }

    // 2. Concatenar audios
    const mergedAudio = path.join(jobDir, 'audio_merged.mp3');
    if (audioPaths.length === 1) {
      await runFFmpeg('-i "' + audioPaths[0] + '" -c:a libmp3lame -ar 44100 -ac 2 -b:a 192k "' + mergedAudio + '"');
    } else {
      const listFile = path.join(jobDir, 'audio_list.txt');
      fs.writeFileSync(listFile, audioPaths.map(p => "file '" + p + "'").join('\n'));
      await runFFmpeg('-analyzeduration 100000000 -probesize 50000000 -f concat -safe 0 -i "' + listFile + '" -c:a libmp3lame -ar 44100 -ac 2 -b:a 192k "' + mergedAudio + '"');
    }

    // 3. Duración total del audio
    const durationOutput = execSync(
      'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + mergedAudio + '"'
    ).toString().trim();
    const totalDuration = parseFloat(durationOutput);
    console.log('[' + jobId + '] Duración total: ' + totalDuration + 's');

    // 3b. Mezclar música de fondo (si se envió un elemento con role:'music')
    let finalAudio = mergedAudio;
    if (musicElements.length > 0) {
      try {
        const musicRaw = path.join(jobDir, 'music_raw.mp3');
        console.log('[' + jobId + '] Descargando musica de fondo');
        await downloadFile(musicElements[0].source, musicRaw);

        const musicLooped = path.join(jobDir, 'music_looped.mp3');
        await runFFmpeg('-stream_loop -1 -i "' + musicRaw + '" -t ' + totalDuration + ' -c:a libmp3lame -ar 44100 -ac 2 "' + musicLooped + '"');

        // volume acepta '12%' (string) o 0.12 (number). Default: 12% -> cama discreta bajo la narración
        const volumeRaw = musicElements[0].volume;
        let musicVolume = 0.12;
        if (typeof volumeRaw === 'string' && volumeRaw.includes('%')) {
          musicVolume = parseFloat(volumeRaw) / 100;
        } else if (typeof volumeRaw === 'number') {
          musicVolume = volumeRaw;
        }

        const mixedAudio = path.join(jobDir, 'audio_with_music.mp3');
        await runFFmpeg(
          '-i "' + mergedAudio + '" -i "' + musicLooped + '" ' +
          '-filter_complex "[1:a]volume=' + musicVolume + '[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=3[aout]" ' +
          '-map "[aout]" -c:a libmp3lame -ar 44100 -ac 2 -b:a 192k "' + mixedAudio + '"'
        );
        finalAudio = mixedAudio;
        console.log('[' + jobId + '] Musica de fondo mezclada (volumen ' + musicVolume + ')');
      } catch (e) {
        console.warn('[' + jobId + '] Error mezclando musica, se continua sin ella: ' + e.message);
      }
    }

    // 4. Descargar clips de video únicos
    const uniqueVideoUrls = [...new Set(videoElements.map(e => e.source))];
    const downloadedClips = {};
    let clipIndex = 0;

    for (const url of uniqueVideoUrls) {
      const clipPath = path.join(jobDir, 'clip_' + clipIndex++ + '.mp4');
      console.log('[' + jobId + '] Descargando clip ' + (clipIndex) + '/' + uniqueVideoUrls.length);
      try {
        await downloadFile(url, clipPath);
        const clipDur = parseFloat(execSync(
          'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + clipPath + '"'
        ).toString().trim());
        downloadedClips[url] = { path: clipPath, duration: clipDur };
      } catch (e) {
        console.warn('[' + jobId + '] Error descargando clip: ' + e.message);
      }
    }

    // 5. Loop de clips hasta cubrir duración
    const clipList = Object.values(downloadedClips);
    if (clipList.length === 0) throw new Error('No se pudieron descargar clips de video');

    const targetDuration = totalDuration * 1.2;
    const videoListFile = path.join(jobDir, 'video_list.txt');
    const videoListLines = [];
    let accDuration = 0;

    while (accDuration < targetDuration) {
      for (const clip of clipList) {
        videoListLines.push("file '" + clip.path + "'");
        accDuration += clip.duration;
        if (accDuration >= targetDuration) break;
      }
    }
    fs.writeFileSync(videoListFile, videoListLines.join('\n'));

    // 6. Concatenar video
    const mergedVideo = path.join(jobDir, 'video_merged.mp4');
    await runFFmpeg('-f concat -safe 0 -i "' + videoListFile + '" -c copy "' + mergedVideo + '"');

    // 7. Combinar video + audio
    const outputFile = path.join(OUTPUT_DIR, jobId + '.mp4');
    await runFFmpeg(
      '-i "' + mergedVideo + '" -i "' + finalAudio + '" ' +
      '-map 0:v:0 -map 1:a:0 ' +
      '-t ' + totalDuration + ' ' +
      '-vf "scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease,pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2:black" ' +
      '-c:v libx264 -preset fast -crf 22 ' +
      '-c:a aac -b:a 192k ' +
      '-movflags +faststart ' +
      '"' + outputFile + '"'
    );

    cleanup(jobDir);

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const videoUrl = protocol + '://' + host + '/outputs/' + jobId + '.mp4';
    console.log('[' + jobId + '] ✅ Render completado: ' + videoUrl);

    return res.json([{ id: jobId, status: 'succeeded', url: videoUrl }]);

  } catch (err) {
    cleanup(jobDir);
    console.error('[' + jobId + '] ❌ Error:', err.message);
    return res.status(500).json({ error: err.message, id: jobId });
  }
});

// ─── Servir outputs ───────────────────────────────────────────────────────────
app.use('/outputs', express.static(OUTPUT_DIR));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', outputs: fs.readdirSync(OUTPUT_DIR).length });
});

// ─── Limpiar outputs viejos (más de 48h) ─────────────────────────────────────
setInterval(() => {
  try {
    const files = fs.readdirSync(OUTPUT_DIR);
    const now = Date.now();
    files.forEach(f => {
      const filePath = path.join(OUTPUT_DIR, f);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 48 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        console.log('[Cleanup] Eliminado:', f);
      }
    });
  } catch (e) {}
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🎬 FFmpeg Renderer API corriendo en puerto ' + PORT);
});
