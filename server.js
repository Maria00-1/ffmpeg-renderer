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

// Crear directorios si no existen
[WORK_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── Helper: descargar archivo con redirect ───────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const protocol = url.startsWith('https') ? https : http;

    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      protocol.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.destroy();
          const redirectUrl = res.headers.location;
          const newProtocol = redirectUrl.startsWith('https') ? https : http;
          newProtocol.get(redirectUrl, (res2) => {
            if (res2.statusCode !== 200) {
              reject(new Error(`Download failed: ${res2.statusCode} for ${redirectUrl}`));
              return;
            }
            res2.pipe(file);
            file.on('finish', () => { file.close(); resolve(dest); });
            file.on('error', reject);
          }).on('error', reject);
        } else if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode} for ${currentUrl}`));
        } else {
          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(dest); });
          file.on('error', reject);
        }
      }).on('error', reject);
    }
    get(url);
  });
}

// ─── Helper: ejecutar FFmpeg como Promise ────────────────────────────────────
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y ${args}`;
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

// ─── Limpiar directorio de trabajo ───────────────────────────────────────────
function cleanup(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ─── Endpoint principal: POST /render ────────────────────────────────────────
// Body esperado (compatible con el payload que ya genera creatomate_payload):
// {
//   "source": {
//     "output_format": "mp4",
//     "width": 1920,
//     "height": 1080,
//     "elements": [
//       { "type": "audio", "track": 2, "source": "https://...", "volume": "100%" },
//       { "type": "video", "track": 1, "source": "https://...", "fit": "cover", "volume": "0%" }
//     ]
//   }
// }
//
// Response:
// { "id": "uuid", "status": "done", "url": "https://tu-dominio/outputs/uuid.mp4" }

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

    // Separar audios y videos
    const audioElements = elements.filter(e => e.type === 'audio');
    const videoElements = elements.filter(e => e.type === 'video');

    console.log(`[${jobId}] Audios: ${audioElements.length}, Videos: ${videoElements.length}`);

    // ── 1. Descargar todos los audios ────────────────────────────────────────
    const audioPaths = [];
    for (let i = 0; i < audioElements.length; i++) {
      const audioPath = path.join(jobDir, `audio_${i}.mp3`);
      console.log(`[${jobId}] Descargando audio ${i + 1}/${audioElements.length}`);
      await downloadFile(audioElements[i].source, audioPath);
      audioPaths.push(audioPath);
    }

    // ── 2. Concatenar audios en uno solo ────────────────────────────────────
    const mergedAudio = path.join(jobDir, 'audio_merged.mp3');
    if (audioPaths.length === 1) {
      fs.copyFileSync(audioPaths[0], mergedAudio);
    } else {
      // Crear lista para concat
      const listFile = path.join(jobDir, 'audio_list.txt');
      fs.writeFileSync(listFile, audioPaths.map(p => `file '${p}'`).join('\n'));
      await runFFmpeg(`-f concat -safe 0 -i "${listFile}" -c copy "${mergedAudio}"`);
    }

    // ── 3. Obtener duración total del audio ──────────────────────────────────
    const durationOutput = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${mergedAudio}"`
    ).toString().trim();
    const totalDuration = parseFloat(durationOutput);
    console.log(`[${jobId}] Duración total del audio: ${totalDuration}s`);

    // ── 4. Descargar clips de video (solo los necesarios para cubrir duración) ─
    // Calculamos cuántos clips necesitamos
    const uniqueVideoUrls = [...new Set(videoElements.map(e => e.source))];
    const videoPaths = [];
    let totalVideoDuration = 0;
    let clipIndex = 0;

    // Descargar clips hasta cubrir la duración del audio + 20% margen
    const targetDuration = totalDuration * 1.2;
    const videoListForDuration = [];

    // Primero descargamos todos los clips únicos
    const downloadedClips = {};
    for (const url of uniqueVideoUrls) {
      const clipPath = path.join(jobDir, `clip_${clipIndex++}.mp4`);
      console.log(`[${jobId}] Descargando clip ${Object.keys(downloadedClips).length + 1}/${uniqueVideoUrls.length}`);
      try {
        await downloadFile(url, clipPath);
        // Obtener duración del clip
        const clipDur = parseFloat(execSync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${clipPath}"`
        ).toString().trim());
        downloadedClips[url] = { path: clipPath, duration: clipDur };
        totalVideoDuration += clipDur;
      } catch (e) {
        console.warn(`[${jobId}] Error descargando clip: ${e.message}`);
      }
    }

    // Construir lista de clips para cubrir la duración (loopeando si es necesario)
    const clipList = Object.values(downloadedClips);
    if (clipList.length === 0) {
      throw new Error('No se pudieron descargar clips de video');
    }

    let accDuration = 0;
    const videoListFile = path.join(jobDir, 'video_list.txt');
    const videoListLines = [];

    while (accDuration < targetDuration) {
      for (const clip of clipList) {
        videoListLines.push(`file '${clip.path}'`);
        accDuration += clip.duration;
        if (accDuration >= targetDuration) break;
      }
    }

    fs.writeFileSync(videoListFile, videoListLines.join('\n'));
    console.log(`[${jobId}] Lista de video: ${videoListLines.length} clips, ~${accDuration.toFixed(0)}s`);

    // ── 5. Concatenar clips de video ────────────────────────────────────────
    const mergedVideo = path.join(jobDir, 'video_merged.mp4');
    await runFFmpeg(`-f concat -safe 0 -i "${videoListFile}" -c copy "${mergedVideo}"`);

    // ── 6. Combinar video + audio, recortar al largo del audio ──────────────
    const outputFile = path.join(OUTPUT_DIR, `${jobId}.mp4`);
    await runFFmpeg(
      `-i "${mergedVideo}" -i "${mergedAudio}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-t ${totalDuration} ` +
      `-vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black" ` +
      `-c:v libx264 -preset fast -crf 22 ` +
      `-c:a aac -b:a 192k ` +
      `-movflags +faststart ` +
      `"${outputFile}"`
    );

    // ── 7. Limpiar archivos temporales ───────────────────────────────────────
    cleanup(jobDir);

    const host = req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const videoUrl = `${protocol}://${host}/outputs/${jobId}.mp4`;

    console.log(`[${jobId}] ✅ Render completado: ${videoUrl}`);

    // Respuesta compatible con el poll que ya hace el workflow
    return res.json([{
      id: jobId,
      status: 'succeeded',
      url: videoUrl
    }]);

  } catch (err) {
    cleanup(jobDir);
    console.error(`[${jobId}] ❌ Error:`, err.message);
    return res.status(500).json({ error: err.message, id: jobId });
  }
});

// ─── Servir los outputs ───────────────────────────────────────────────────────
app.use('/outputs', express.static(OUTPUT_DIR));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', outputs: fs.readdirSync(OUTPUT_DIR).length });
});

// ─── Limpiar outputs viejos (más de 48h) ──────────────────────────────────────
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
}, 60 * 60 * 1000); // cada hora

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎬 FFmpeg Renderer API corriendo en puerto ${PORT}`);
});
