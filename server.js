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

// ─── Helper: reintentar una descarga con backoff (Pollinations es gratis y
// devuelve 429 bajo concurrencia; sin esto un solo rate-limit tira todo el render) ──
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function downloadFileWithRetry(url, dest, maxRetries) {
  if (maxRetries === undefined) maxRetries = 6;
  const MAX_BACKOFF_MS = 20000;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await downloadFile(url, dest);
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
        console.warn('[retry] ' + e.message + ' -> reintentando en ' + backoff + 'ms (intento ' + (attempt + 1) + '/' + maxRetries + ')');
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// ─── Helper: gate global de ritmo — Pollinations documenta el límite anónimo
// en 1 petición cada 15s (no por conexión concurrente, es una ventana de tiempo
// real). 1.2s se quedaba corto por un orden de magnitud. Si Edgar registra un
// token gratis en auth.pollinations.ai (tier "Seed", 1 req/5s), este valor se
// puede bajar a ~6000ms.
let nextAllowedStart = 0;
const PACING_MS = 16000;
async function paceRequest() {
  const now = Date.now();
  const waitMs = Math.max(nextAllowedStart - now, 0);
  nextAllowedStart = Math.max(now, nextAllowedStart) + PACING_MS;
  if (waitMs > 0) await sleep(waitMs);
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
    // Escenas visuales: clips de video reales (stock) e imagenes (Ken Burns), mezclables
    const imageElements = elements.filter(e => e.type === 'image' || e.type === 'video').sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
    const videoCount = imageElements.filter(e => e.type === 'video').length;
    console.log('[' + jobId + '] Audios: ' + audioElements.length + ', Musica: ' + musicElements.length + ', Escenas: ' + imageElements.length + ' (' + videoCount + ' video, ' + (imageElements.length - videoCount) + ' imagen)');

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

    // 4. Descargar imágenes de escena (concurrencia limitada — Pollinations tarda varios
    // segundos por imagen, secuencial habría añadido ~15min al render con 80-90 escenas)
    if (imageElements.length === 0) throw new Error('No se recibieron escenas de imagen');

    const scenePaths = new Array(imageElements.length);
    const DOWNLOAD_CONCURRENCY = 2;
    let nextDl = 0;
    async function downloadWorker() {
      while (nextDl < imageElements.length) {
        const i = nextDl++;
        const ext = imageElements[i].type === 'video' ? '.mp4' : '.jpg';
        const imgPath = path.join(jobDir, 'scene_' + i + ext);
        // El pacing solo protege contra el rate limit de Pollinations; para fuentes
        // normales (Drive, Pexels, CDN) espaciar 16s por elemento solo alarga el render.
        if ((imageElements[i].source || '').includes('pollinations.ai')) {
          await paceRequest();
        }
        console.log('[' + jobId + '] Descargando escena ' + (i + 1) + '/' + imageElements.length);
        await downloadFileWithRetry(imageElements[i].source, imgPath);
        scenePaths[i] = imgPath;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, imageElements.length) }, downloadWorker)
    );

    // 5. Escalar duraciones de escena para que la suma cuadre exacto con el audio real
    // (el n8n solo manda una estimación por palabras; el ajuste fino se hace aquí porque
    // totalDuration real del audio narrado solo se conoce tras el ffprobe del paso 3)
    const rawDurs = imageElements.map(e => Math.max(parseFloat(e.dur) || 3, 3));
    const rawSum = rawDurs.reduce((a, b) => a + b, 0);
    const scale = totalDuration / rawSum;
    const scaledDurs = rawDurs.map(d => d * scale);
    const roundedSum = scaledDurs.reduce((a, b) => a + b, 0);
    scaledDurs[scaledDurs.length - 1] += (totalDuration - roundedSum);

    // 6. Renderizar cada escena: clips de video reales se recortan/loopean a la duración
    // de la escena (sin su audio original); las imágenes llevan efecto Ken Burns
    // (zoom in/out alternado por índice). Todos salen uniformes: 1920x1080, 25fps, h264.
    const sceneClipPaths = [];
    for (let i = 0; i < imageElements.length; i++) {
      const dur = scaledDurs[i];
      const clipPath = path.join(jobDir, 'clip_' + i + '.mp4');
      if (imageElements[i].type === 'video') {
        const vfVid = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=25,' +
          'fade=t=in:d=0.5,fade=t=out:st=' + Math.max(dur - 0.5, 0) + ':d=0.5';
        await runFFmpeg(
          '-stream_loop -1 -i "' + scenePaths[i] + '" -t ' + dur + ' -vf "' + vfVid + '" ' +
          '-an -c:v libx264 -preset veryfast -pix_fmt yuv420p "' + clipPath + '"'
        );
      } else {
        const frames = Math.max(Math.round(dur * 25), 1);
        const zoomExpr = (i % 2 === 0)
          ? "min(zoom+0.0008,1.15)"
          : "max(1.15-0.0008*on,1.0)";
        const vf = 'scale=2400:-2,zoompan=z=\'' + zoomExpr + '\':d=' + frames +
          ':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=1920x1080:fps=25,' +
          'fade=t=in:d=0.5,fade=t=out:st=' + Math.max(dur - 0.5, 0) + ':d=0.5';
        await runFFmpeg(
          '-loop 1 -i "' + scenePaths[i] + '" -t ' + dur + ' -vf "' + vf + '" ' +
          '-c:v libx264 -preset veryfast -pix_fmt yuv420p "' + clipPath + '"'
        );
      }
      sceneClipPaths.push(clipPath);
    }

    // 7. Concatenar las escenas ya renderizadas
    const mergedVideo = path.join(jobDir, 'video_merged.mp4');
    const videoListFile = path.join(jobDir, 'video_list.txt');
    fs.writeFileSync(videoListFile, sceneClipPaths.map(p => "file '" + p + "'").join('\n'));
    await runFFmpeg('-f concat -safe 0 -i "' + videoListFile + '" -c copy "' + mergedVideo + '"');

    // 8. Combinar video de escenas + audio narración/música (duración exacta de la narración)
    const narrationCombined = path.join(jobDir, 'narration_combined.mp4');
    await runFFmpeg(
      '-i "' + mergedVideo + '" -i "' + finalAudio + '" ' +
      '-map 0:v:0 -map 1:a:0 ' +
      '-t ' + totalDuration + ' ' +
      '-vf "scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease,pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2:black" ' +
      '-c:v libx264 -preset veryfast -crf 22 ' +
      '-c:a aac -b:a 192k ' +
      '"' + narrationCombined + '"'
    );

    // 9. Anteponer el intro de marca (horneado en /app/assets/intro.mp4 en el Docker build)
    // SOLO si el payload lo pide (source.intro truthy, ej. intro:'collapse'). El renderer es
    // compartido entre canales: sin flag el video sale sin intro (Dark LATAM no manda flag).
    // Degrada a narración sola si el asset no existe, mismo patrón defensivo que la musica.
    const outputFile = path.join(OUTPUT_DIR, jobId + '.mp4');
    const introPath = '/app/assets/intro.mp4';
    const introRequested = !!source.intro;
    if (introRequested && fs.existsSync(introPath)) {
      await runFFmpeg(
        '-i "' + introPath + '" -i "' + narrationCombined + '" -filter_complex ' +
        '"[0:v]scale=' + width + ':' + height + ',setsar=1,fps=25[iv];[1:v]setsar=1,fps=25[nv];' +
        '[iv][0:a][nv][1:a]concat=n=2:v=1:a=1[outv][outa]" ' +
        '-map "[outv]" -map "[outa]" ' +
        '-c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -movflags +faststart ' +
        '"' + outputFile + '"'
      );
    } else {
      fs.copyFileSync(narrationCombined, outputFile);
      if (introRequested) {
        console.warn('[' + jobId + '] intro solicitado pero intro.mp4 no existe en la imagen, se publica sin intro');
      }
    }

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

// ══════════════════════════════════════════════════════════════════════════════
// RENDER V2 — corte rápido al ritmo de la narración (canal "The Missing Page")
//
// Diferencias con /render (que NO se toca, Dark LATAM sigue usándolo):
//  - Genera las imágenes aquí dentro (Replicate Flux Schnell) en vez de recibir URLs
//    ya resueltas. Motivo: Flux tarda 26-40s por imagen y n8n no puede esperar a 65
//    imágenes (el nodo Wait está roto en esa instancia y los Code node mueren a 60s).
//    Aquí no hay ese límite: concurrencia real + polling + reintentos.
//  - Corte seco entre planos en vez de fundido a negro por escena. Con planos de ~5s
//    el fade in/out de /render provocaría un parpadeo negro constante.
//  - Movimiento de cámara variado (6 patrones) en vez de zoom in/out alternado.
// ══════════════════════════════════════════════════════════════════════════════

const REPLICATE_MODEL_URL = 'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions';

// Replicate tolera peticiones en serie sin 429 (medido), pero NO ráfagas. Este gate
// global espacia la CREACIÓN de predicciones; una vez creadas corren en paralelo en
// su infraestructura, así que la concurrencia real no la limita este valor.
let nextReplicateStart = 0;
const REPLICATE_PACING_MS = 1500;
async function paceReplicate() {
  const now = Date.now();
  const waitMs = Math.max(nextReplicateStart - now, 0);
  nextReplicateStart = Math.max(now, nextReplicateStart) + REPLICATE_PACING_MS;
  if (waitMs > 0) await sleep(waitMs);
}

// Genera una imagen y devuelve su URL. Crea la predicción y, si no ha terminado
// dentro de la ventana `Prefer: wait`, hace polling — el bug que rompía el pipeline
// viejo era tratar ese caso (HTTP 202 "starting") como un fallo: la imagen se estaba
// generando bien, simplemente aún no estaba lista.
async function generateImageReplicate(token, prompt, seed, jobId, idx) {
  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await paceReplicate();

      const createRes = await fetch(REPLICATE_MODEL_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Prefer': 'wait=60'
        },
        body: JSON.stringify({
          input: {
            prompt: prompt,
            aspect_ratio: '16:9',
            num_outputs: 1,
            output_format: 'jpg',
            output_quality: 90,
            seed: seed
          }
        })
      });

      if (createRes.status === 429) {
        throw new Error('429 rate limit');
      }
      if (!createRes.ok && createRes.status !== 201 && createRes.status !== 202) {
        const body = await createRes.text();
        throw new Error('Replicate ' + createRes.status + ': ' + body.slice(0, 200));
      }

      let pred = await createRes.json();

      // Polling: la predicción existe y está corriendo, solo hay que esperarla.
      const POLL_DEADLINE = Date.now() + 180000;
      while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
        if (Date.now() > POLL_DEADLINE) throw new Error('timeout esperando la prediccion');
        await sleep(2500);
        const pollRes = await fetch(pred.urls.get, {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!pollRes.ok) throw new Error('poll ' + pollRes.status);
        pred = await pollRes.json();
      }

      if (pred.status !== 'succeeded') {
        throw new Error('prediccion ' + pred.status + ': ' + (pred.error || 'sin detalle'));
      }

      const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      if (!url) throw new Error('prediccion sin output');
      return url;

    } catch (e) {
      lastErr = e;
      console.warn('[' + jobId + '] escena ' + idx + ' intento ' + attempt + '/' + MAX_ATTEMPTS + ' fallo: ' + e.message);
      if (attempt < MAX_ATTEMPTS) await sleep(4000 * attempt);
    }
  }
  throw lastErr;
}

// Movimiento de cámara variado. Con planos de ~5s, repetir siempre el mismo zoom
// delata el automatismo; alternar 6 patrones es lo que da sensación de montaje.
// La imagen entra escalada a 2400px de ancho para que el zoompan tenga margen real
// de recorte y no interpole píxeles inventados.
function kenBurnsVf(idx, dur) {
  const frames = Math.max(Math.round(dur * 25), 2);
  const d = frames;
  const last = d - 1; // evita division por cero cuando d = 2
  const variant = idx % 6;

  // Con zoom fijo, el margen horizontal/vertical disponible para panear es
  // (iw - iw/zoom) — recorrerlo de un extremo al otro produce el paneo.
  const Z = '1.12';
  const panX = "(iw-iw/zoom)*on/" + last;
  const panXrev = "(iw-iw/zoom)*(1-on/" + last + ")";
  const panY = "(ih-ih/zoom)*on/" + last;
  const panYrev = "(ih-ih/zoom)*(1-on/" + last + ")";
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";

  let z, x, y;
  switch (variant) {
    case 0: z = "min(zoom+0.0012,1.18)"; x = cx;      y = cy;      break; // zoom in centro
    case 1: z = "max(1.18-0.0012*on,1.0)"; x = cx;    y = cy;      break; // zoom out centro
    case 2: z = Z;                        x = panX;   y = cy;      break; // paneo izq -> der
    case 3: z = Z;                        x = panXrev; y = cy;     break; // paneo der -> izq
    case 4: z = "min(zoom+0.0010,1.16)";  x = cx;     y = panYrev; break; // zoom in + sube
    default: z = "max(1.16-0.0010*on,1.0)"; x = cx;   y = panY;    break; // zoom out + baja
  }

  return "scale=2400:-2,zoompan=z='" + z + "':d=" + d +
         ":x='" + x + "':y='" + y + "':s=1920x1080:fps=25";
}

app.post('/render-v2', async (req, res) => {
  const jobId = uuidv4();
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  try {
    const body = req.body || {};
    const width = body.width || 1920;
    const height = body.height || 1080;
    const scenes = body.scenes;
    const token = process.env.REPLICATE_API_TOKEN || body.replicate_token;

    if (!body.narration_url) return res.status(400).json({ error: 'Falta narration_url' });
    if (!Array.isArray(scenes) || scenes.length === 0) return res.status(400).json({ error: 'Falta scenes[]' });

    const needsGeneration = scenes.some(s => !s.source && s.prompt);
    if (needsGeneration && !token) {
      return res.status(400).json({ error: 'Falta REPLICATE_API_TOKEN (env del servicio) o replicate_token en el payload' });
    }

    console.log('[' + jobId + '] v2 — ' + scenes.length + ' escenas');

    // 1. Narración
    const narrationPath = path.join(jobDir, 'narration.mp3');
    await downloadFileWithRetry(body.narration_url, narrationPath);
    const mergedAudio = path.join(jobDir, 'audio_merged.mp3');
    await runFFmpeg('-i "' + narrationPath + '" -c:a libmp3lame -ar 44100 -ac 2 -b:a 192k "' + mergedAudio + '"');

    const totalDuration = parseFloat(execSync(
      'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + mergedAudio + '"'
    ).toString().trim());
    console.log('[' + jobId + '] narracion: ' + totalDuration + 's');

    // 2. Música de fondo (opcional) — mismo patrón defensivo que /render
    let finalAudio = mergedAudio;
    if (body.music_url) {
      try {
        const musicRaw = path.join(jobDir, 'music_raw.mp3');
        await downloadFileWithRetry(body.music_url, musicRaw);
        const musicLooped = path.join(jobDir, 'music_looped.mp3');
        await runFFmpeg('-stream_loop -1 -i "' + musicRaw + '" -t ' + totalDuration + ' -c:a libmp3lame -ar 44100 -ac 2 "' + musicLooped + '"');
        const vol = typeof body.music_volume === 'number' ? body.music_volume : 0.10;
        const mixed = path.join(jobDir, 'audio_mixed.mp3');
        await runFFmpeg(
          '-i "' + mergedAudio + '" -i "' + musicLooped + '" ' +
          '-filter_complex "[1:a]volume=' + vol + '[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=3[a]" ' +
          '-map "[a]" -c:a libmp3lame -ar 44100 -ac 2 -b:a 192k "' + mixed + '"'
        );
        finalAudio = mixed;
      } catch (e) {
        console.warn('[' + jobId + '] musica falla, se continua sin ella: ' + e.message);
      }
    }

    // 3. Resolver cada escena a un archivo local, en paralelo.
    // Una escena puede venir ya con `source` (clip de Pexels, imagen previa) o solo
    // con `prompt` (hay que generarla). Si una escena falla del todo NO se aborta el
    // render: se marca como hueco y luego se rellena con la escena válida más cercana
    // — perder un plano de 5s es aceptable, perder el vídeo entero no.
    const scenePaths = new Array(scenes.length).fill(null);
    const sceneTypes = new Array(scenes.length).fill('image');
    const CONCURRENCY = 4;
    let nextScene = 0;
    let generated = 0;

    async function sceneWorker() {
      while (nextScene < scenes.length) {
        const i = nextScene++;
        const s = scenes[i];
        try {
          let url = s.source;
          const isVideo = s.type === 'video';

          if (!url) {
            url = await generateImageReplicate(
              token,
              s.prompt,
              typeof s.seed === 'number' ? s.seed : (1000 + i),
              jobId,
              i
            );
            generated++;
            console.log('[' + jobId + '] escena ' + (i + 1) + '/' + scenes.length + ' generada (' + generated + ' ok)');
          }

          const ext = isVideo ? '.mp4' : '.jpg';
          const dest = path.join(jobDir, 'scene_' + i + ext);
          await downloadFileWithRetry(url, dest, 4);
          scenePaths[i] = dest;
          sceneTypes[i] = isVideo ? 'video' : 'image';
        } catch (e) {
          console.error('[' + jobId + '] escena ' + i + ' PERDIDA: ' + e.message);
          scenePaths[i] = null;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenes.length) }, sceneWorker));

    // Rellenar huecos con la escena válida más cercana (atrás, luego adelante)
    const okCount = scenePaths.filter(Boolean).length;
    if (okCount === 0) throw new Error('Ninguna escena pudo resolverse');
    for (let i = 0; i < scenePaths.length; i++) {
      if (scenePaths[i]) continue;
      let fill = null;
      for (let b = i - 1; b >= 0 && !fill; b--) if (scenePaths[b]) fill = b;
      for (let f = i + 1; f < scenePaths.length && !fill; f++) if (scenePaths[f]) fill = f;
      scenePaths[i] = scenePaths[fill];
      sceneTypes[i] = sceneTypes[fill];
    }
    console.log('[' + jobId + '] escenas resueltas: ' + okCount + '/' + scenes.length);

    // 4. Reescalar duraciones para que la suma cuadre EXACTO con el audio real.
    // n8n solo manda una estimación por palabras; la duración real solo se conoce
    // aquí, tras el ffprobe.
    const rawDurs = scenes.map(s => Math.max(parseFloat(s.dur) || 5, 1.5));
    const rawSum = rawDurs.reduce((a, b) => a + b, 0);
    const scale = totalDuration / rawSum;
    const durs = rawDurs.map(d => d * scale);
    durs[durs.length - 1] += (totalDuration - durs.reduce((a, b) => a + b, 0));

    // 5. Renderizar cada plano. CORTE SECO: sin fundido a negro entre escenas.
    // Solo fade-in al principio del vídeo y fade-out al final.
    const clips = [];
    for (let i = 0; i < scenes.length; i++) {
      const dur = durs[i];
      const clipPath = path.join(jobDir, 'clip_' + i + '.mp4');
      const isFirst = i === 0;
      const isLast = i === scenes.length - 1;

      let tail = '';
      if (isFirst) tail += ',fade=t=in:d=0.6';
      if (isLast) tail += ',fade=t=out:st=' + Math.max(dur - 0.8, 0) + ':d=0.8';

      if (sceneTypes[i] === 'video') {
        const vf = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=25' + tail;
        await runFFmpeg(
          '-stream_loop -1 -i "' + scenePaths[i] + '" -t ' + dur + ' -vf "' + vf + '" ' +
          '-an -c:v libx264 -preset veryfast -pix_fmt yuv420p "' + clipPath + '"'
        );
      } else {
        const vf = kenBurnsVf(i, dur) + tail;
        await runFFmpeg(
          '-loop 1 -i "' + scenePaths[i] + '" -t ' + dur + ' -vf "' + vf + '" ' +
          '-c:v libx264 -preset veryfast -pix_fmt yuv420p "' + clipPath + '"'
        );
      }
      clips.push(clipPath);
    }

    // 6. Concatenar (-c copy: los clips ya salen uniformes 1920x1080/25fps/h264)
    const mergedVideo = path.join(jobDir, 'video_merged.mp4');
    const listFile = path.join(jobDir, 'video_list.txt');
    fs.writeFileSync(listFile, clips.map(p => "file '" + p + "'").join('\n'));
    await runFFmpeg('-f concat -safe 0 -i "' + listFile + '" -c copy "' + mergedVideo + '"');

    // 7. Vídeo + audio
    const outputFile = path.join(OUTPUT_DIR, jobId + '.mp4');
    await runFFmpeg(
      '-i "' + mergedVideo + '" -i "' + finalAudio + '" ' +
      '-map 0:v:0 -map 1:a:0 -t ' + totalDuration + ' ' +
      '-c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 192k -movflags +faststart ' +
      '"' + outputFile + '"'
    );

    cleanup(jobDir);

    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const videoUrl = protocol + '://' + req.headers.host + '/outputs/' + jobId + '.mp4';
    console.log('[' + jobId + '] ✅ v2 completado: ' + videoUrl);

    return res.json({
      id: jobId,
      status: 'succeeded',
      url: videoUrl,
      duracion_seg: totalDuration,
      escenas_total: scenes.length,
      escenas_ok: okCount,
      escenas_rellenadas: scenes.length - okCount
    });

  } catch (err) {
    cleanup(jobDir);
    console.error('[' + jobId + '] ❌ v2 error:', err.message);
    return res.status(500).json({ error: err.message, id: jobId });
  }
});

// ─── Servir outputs ───────────────────────────────────────────────────────────
app.use('/outputs', express.static(OUTPUT_DIR));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  // Se reportan solo NOMBRES de variables, nunca valores: sirve para diagnosticar
  // "la variable esta guardada en el panel pero el contenedor no la ve" sin filtrar secretos.
  const envKeys = Object.keys(process.env).filter(k => !/^(npm_|PATH|HOME|HOSTNAME|PWD|SHLVL|_$)/.test(k)).sort();
  res.json({
    status: 'ok',
    outputs: fs.readdirSync(OUTPUT_DIR).length,
    render_v2: true,
    replicate_token_presente: !!process.env.REPLICATE_API_TOKEN,
    env_keys: envKeys
  });
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
