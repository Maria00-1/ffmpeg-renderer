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
// ─── Generar imagen GRATIS en Cloudflare Workers AI (flux-1-schnell) ─────────
// Free tier: 10.000 neurons/dia ≈ 181 imagenes 1024x576 — cubre un video diario entero.
// Devuelve un Buffer con el JPEG/PNG, o null si falla (el caller cae a Replicate).
// Requiere CF_ACCOUNT_ID y CLOUDFLARE_API_TOKEN (token con permiso "Workers AI").
async function generateImageCloudflare(prompt, seed, jobId, idx) {
  const acc = process.env.CF_ACCOUNT_ID;
  const tok = process.env.CLOUDFLARE_API_TOKEN;
  if (!acc || !tok) return null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/accounts/' + acc + '/ai/run/@cf/black-forest-labs/flux-1-schnell', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.slice(0, 2048), steps: 4, width: 1024, height: 576, seed: seed })
      });
      if (!res.ok) throw new Error('CF ' + res.status);
      const d = await res.json();
      if (!d.success || !d.result || !d.result.image) throw new Error('CF sin imagen: ' + JSON.stringify(d.errors || {}).slice(0, 100));
      return Buffer.from(d.result.image, 'base64');
    } catch (e) {
      console.warn('[' + jobId + '] CF escena ' + idx + ' intento ' + attempt + ': ' + e.message);
      if (attempt < 2) await sleep(2000);
    }
  }
  return null; // caller cae a Replicate
}

// Simplifica un prompt que Replicate rechaza. Hay prompts que fallan SIEMPRE con
// `E9828 Director: unexpected error` (comprobado: el mismo prompt fallo 3 veces seguidas
// mientras otro funcionaba a la primera), asi que reintentarlo identico no sirve de nada
// — solo gasta tiempo y acaba en un plano duplicado, que es justo lo que hay que evitar.
// Se le quita la cola de estilo, se recorta y se cambia la semilla.
function simplificarPrompt(prompt) {
  const sinEstilo = prompt.split(/,\s*(?:stylized 2D|cinematic|no text)/i)[0];
  const palabras = sinEstilo.split(/\s+/).slice(0, 18).join(' ').replace(/[^a-zA-Z0-9 ,.'-]/g, '');
  return palabras + ', hand drawn 2D illustration, flat color, historical scene, no text';
}

async function generateImageReplicate(token, prompt, seed, jobId, idx) {
  const MAX_ATTEMPTS = 5;
  const SIMPLIFICAR_DESDE = 3; // los 2 primeros intentos con el prompt original
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const usarSimple = attempt >= SIMPLIFICAR_DESDE;
    const promptActual = usarSimple ? simplificarPrompt(prompt) : prompt;
    const seedActual = usarSimple ? (seed + attempt * 137) : seed;
    if (usarSimple && attempt === SIMPLIFICAR_DESDE) {
      console.warn('[' + jobId + '] escena ' + idx + ': el prompt original falla, probando version simplificada');
    }

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
            prompt: promptActual,
            aspect_ratio: '16:9',
            num_outputs: 1,
            output_format: 'jpg',
            output_quality: 90,
            seed: seedActual
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
      if (attempt < MAX_ATTEMPTS) {
        // Un 429 significa que Replicate esta saturado: esperar mas que ante un error
        // normal. Los E9828 ("Director: unexpected error") son transitorios y suelen
        // pasar al siguiente intento.
        const es429 = /429/.test(e.message);
        await sleep(es429 ? 15000 + 5000 * attempt : 4000 * attempt);
      }
    }
  }
  throw lastErr;
}

// ─── Animar una imagen fija (image-to-video) ──────────────────────────────────
// Convierte el plano en movimiento REAL dentro del encuadre (la llama parpadea, la
// mano escribe, la camara entra) en vez de un Ken Burns sobre una foto quieta.
// Medido: ~22s de computo por clip de 5s => ~0,02-0,03 USD por plano.
// Si falla, se devuelve null y el plano cae de vuelta a imagen + Ken Burns: animar
// es una mejora, nunca un punto de fallo que tumbe el video.
const WAN_MODEL_URL = 'https://api.replicate.com/v1/models/wan-video/wan-2.2-i2v-fast/predictions';
// Alternativa destilada (Wan 2.1 + CausVid LoRA, 4 pasos): ~0,014 USD/clip medido, un
// tercio del wan-2.2 (~0,046). Es lo que permite un video 100% animado por <2 USD.
// Es un modelo de comunidad: se invoca por VERSION en /v1/predictions, no por nombre
// (por nombre devuelve 404 — comprobado).
const WAN_CHEAP_VERSION = 'e3e2b581dffc5a971ab8ef6322f53d93b83c277ec802a5d6bae0f3b62cf592bf';
const PREDICTIONS_URL = 'https://api.replicate.com/v1/predictions';

async function animateImageReplicate(token, imageUrl, motionPrompt, seed, jobId, idx, resolution, model) {
  const usarBarato = model === 'cheap';
  // 3 intentos con espera larga ante 429: con saldo bajo Replicate recorta a rafaga de 1
  // y con 2 intentos secos las animaciones caian a Ken Burns en silencio — el video salia
  // sin el "todo animado" que es requisito. Un intento extra cuesta centimos.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await paceReplicate();

      const prompt = motionPrompt || 'subtle natural movement in the scene, gentle slow camera push in, soft shifting light';
      const endpointUrl = usarBarato ? PREDICTIONS_URL : WAN_MODEL_URL;
      const body = usarBarato
        ? {
            version: WAN_CHEAP_VERSION,
            // 65 frames a 16fps = 4,06s de clip; con planos de max 4,6s el estiramiento
            // queda en 1,13x como mucho, imperceptible.
            input: { input_image: imageUrl, prompt: prompt, num_frames: 65, frames_per_second: 16, seed: seed }
          }
        : {
            input: { image: imageUrl, prompt: prompt, num_frames: 81, frames_per_second: 16, resolution: resolution || '480p', seed: seed }
          };

      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Prefer': 'wait=60'
        },
        body: JSON.stringify(body)
      });

      if (res.status === 429) throw new Error('429 rate limit');
      if (!res.ok && res.status !== 201 && res.status !== 202) {
        throw new Error('wan ' + res.status + ': ' + (await res.text()).slice(0, 150));
      }

      let pred = await res.json();
      const DEADLINE = Date.now() + 300000;
      while (pred.status !== 'succeeded' && pred.status !== 'failed' && pred.status !== 'canceled') {
        if (Date.now() > DEADLINE) throw new Error('timeout animando');
        await sleep(3000);
        const pr = await fetch(pred.urls.get, { headers: { 'Authorization': 'Bearer ' + token } });
        if (!pr.ok) throw new Error('poll ' + pr.status);
        pred = await pr.json();
      }
      if (pred.status !== 'succeeded') throw new Error('animacion ' + pred.status + ': ' + (pred.error || ''));

      const url = Array.isArray(pred.output) ? pred.output[0] : pred.output;
      if (!url) throw new Error('animacion sin output');
      return url;

    } catch (e) {
      console.warn('[' + jobId + '] animar escena ' + idx + ' intento ' + attempt + ': ' + e.message);
      if (attempt < MAX_ATTEMPTS) {
        const es429 = /429/.test(e.message);
        await sleep(es429 ? 15000 + 5000 * attempt : 5000 * attempt);
      }
    }
  }
  return null; // degrada a imagen fija + Ken Burns
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
    const animarGlobal = body.animate === true;
    const resolucionAnim = body.animate_resolution || '480p';
    // 'cheap' = wan2.1-4step (~0,014 USD/clip) | cualquier otro valor = wan-2.2 (~0,046)
    const modeloAnim = body.animate_model || 'fast';
    // Base publica de este mismo servicio: las imagenes de Cloudflare se sirven desde
    // /outputs para que el modelo de animacion (que exige URL) pueda descargarlas.
    const publicBase = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;
    let nextScene = 0;
    let generated = 0;
    let generatedCF = 0;
    let animated = 0;
    let animFallidas = 0;

    async function sceneWorker() {
      while (nextScene < scenes.length) {
        const i = nextScene++;
        const s = scenes[i];
        try {
          let url = s.source;
          let isVideo = s.type === 'video';

          if (!url) {
            const seedEscena = typeof s.seed === 'number' ? s.seed : (1000 + i);
            // Primero Cloudflare (gratis, ~181 imagenes/dia); si falla o no esta
            // configurado, Replicate (~0,003 USD). Mover las imagenes fuera de
            // Replicate ademas le quita la mitad de la presion de rate limit.
            const cfBuf = await generateImageCloudflare(s.prompt, seedEscena, jobId, i);
            if (cfBuf) {
              const tmpName = jobId + '_src_' + i + '.jpg';
              fs.writeFileSync(path.join(OUTPUT_DIR, tmpName), cfBuf);
              url = publicBase + '/outputs/' + tmpName;
              generatedCF++;
            } else {
              url = await generateImageReplicate(token, s.prompt, seedEscena, jobId, i);
            }
            generated++;

            // Animar el plano recien generado. `animate: false` en la escena permite
            // dejar planos concretos como imagen fija (mas barato) sin tocar el resto.
            if (animarGlobal && s.animate !== false) {
              const vid = await animateImageReplicate(
                token, url, s.motion, (typeof s.seed === 'number' ? s.seed : (1000 + i)), jobId, i, resolucionAnim, modeloAnim
              );
              if (vid) {
                url = vid;
                isVideo = true;
                animated++;
              } else {
                animFallidas++;
              }
            }
            console.log('[' + jobId + '] escena ' + (i + 1) + '/' + scenes.length +
              ' lista (' + (isVideo ? 'animada' : 'fija') + ') — ' + animated + ' animadas de ' + generated);
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
        // NUNCA repetir el clip en bucle para rellenar un plano mas largo que el.
        // El clip animado dura ~5s; con planos de ~9s, el `-stream_loop -1` de antes
        // reiniciaba el movimiento a mitad de plano y se veia como un bucle evidente
        // (Edgar lo detecto en el primer video real). En su lugar se ESTIRA el tiempo:
        // un 10-30% de ralentizacion es imperceptible, un bucle salta a la vista.
        let clipDur = 0;
        try {
          clipDur = parseFloat(execSync(
            'ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "' + scenePaths[i] + '"'
          ).toString().trim()) || 0;
        } catch (e) { clipDur = 0; }

        let pre = '';
        let vf = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080';

        if (clipDur > 0.5 && dur > clipDur + 0.05) {
          const factor = dur / clipDur;
          if (factor <= 2.5) {
            // Estirar el clip hasta cubrir el plano entero
            vf = 'setpts=' + factor.toFixed(4) + '*PTS,' + vf;
          } else {
            // Plano desproporcionadamente largo para el clip: estirar al maximo
            // razonable y congelar el ultimo fotograma el resto (mejor un cierre
            // quieto que un bucle).
            vf = 'setpts=2.5*PTS,' + vf + ',tpad=stop_mode=clone:stop_duration=' + (dur - clipDur * 2.5).toFixed(2);
          }
        }
        vf += ',fps=25' + tail;

        await runFFmpeg(
          pre + '-i "' + scenePaths[i] + '" -t ' + dur + ' -vf "' + vf + '" ' +
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
      escenas_rellenadas: scenes.length - okCount,
      escenas_animadas: animated,
      animaciones_fallidas: animFallidas,
      imagenes_cloudflare_gratis: generatedCF
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
    // EasyPanel no redespliega solo tras un push y no habia forma de saber que version
    // corria de verdad. Con el commit expuesto aqui, verificar un deploy es una peticion.
    git_sha: (process.env.GIT_SHA || 'desconocido').slice(0, 7),
    deploy: process.env.DEPLOY_TIMESTAMP || 'desconocido',
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
