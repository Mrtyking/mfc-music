// Audio de YouTube a través de yt-dlp, servido desde el disco del servidor.
// YouTube bloquea a los servidores (IP de Contabo marcada como bot). Lo que sí funciona: yt-dlp con las cookies
// de una cuenta secundaria + PO token (servidor bgutil en 127.0.0.1:4416) + cliente "mweb". Devuelve un enlace
// directo de googlevideo (válido unas horas y solo desde la IP que lo pidió).
//
// Cómo se reproduce sin cortes y rápido:
//  - Las canciones se ponen en la cola como "pendientes" con un enlace local http://127.0.0.1:4417/yt/<id>.
//  - Al pedir una canción se empieza a bajar al disco (cache/audio) a toda velocidad, en trozos de 10 MB.
//  - El motor de audio lee de este servidor local: suena en cuanto llegan los primeros datos y, como la descarga
//    va mucho más rápido que la reproducción, a los pocos segundos ya no depende de YouTube (sin cortes).
//  - Lo descargado se queda en caché: si alguien repite una canción, suena al instante.
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
const CACHE_DIR = path.join(ROOT, 'cache', 'audio');
const RESOLVER_PORT = 4417;
const MAX_PARALLEL = 3; // yt-dlp a la vez
const CHUNK = 10 * 1024 * 1024; // trozos de 10 MB (googlevideo frena las descargas sin rango)
const MAX_CACHE_BYTES = 5 * 1024 ** 3; // 5 GB de canciones guardadas como máximo

const YT_ID_RE = /^[\w-]{11}$/;
const COOKIES = path.join(ROOT, 'secrets', 'youtube-cookies.txt');
// Reserva: otra sesión de la misma cuenta. Si YouTube rechaza la principal, se prueba con esta.
const BACKUP_COOKIES = path.join(ROOT, 'secrets', 'youtube-cookies-reserva.txt');

fs.mkdirSync(CACHE_DIR, { recursive: true });
const finalPath = (id) => path.join(CACHE_DIR, `${id}.mp4`);
const metaPath = (id) => path.join(CACHE_DIR, `${id}.json`);
const partPath = (id) => path.join(CACHE_DIR, `${id}.mp4.part`);
// Restos de descargas cortadas por un reinicio
for (const f of fs.readdirSync(CACHE_DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(CACHE_DIR, f), { force: true });

// ── yt-dlp: datos del vídeo + enlace directo ─────────────────────────────────
const waiting = [];
let running = 0;

function runYtdlp(id, fast = true, cookiesFile = COOKIES) {
  // yt-dlp reescribe el archivo de cookies al terminar: se le da una copia para que nunca toque el original
  const tmpCookies = path.join(ROOT, 'secrets', `.run-${id}-${process.pid}-${Date.now()}.txt`);
  try {
    fs.copyFileSync(cookiesFile, tmpCookies);
    fs.chmodSync(tmpCookies, 0o600);
  } catch {
    console.warn('[YT] Falta el archivo de cookies de YouTube');
    return Promise.resolve(null);
  }
  const args = [
    // El enlace de audio queda atado a la IP que lo pide: se pide y se descarga siempre por IPv4
    '--force-ipv4',
    '--plugin-dirs', path.join(ROOT, 'ytdlp-plugins'),
    '--js-runtimes', `deno:${path.join(BIN, 'deno')}`,
    '--remote-components', 'ejs:github',
    '--cookies', tmpCookies,
    // Versión rápida: sin descargar la página del vídeo (~2 s menos). Si falla, se repite con la normal.
    '--extractor-args', fast ? 'youtube:player_client=mweb;player_skip=webpage,configs' : 'youtube:player_client=mweb',
    '-f', 'ba/18/b',
    '--no-warnings', '--no-playlist',
    // available_at: algunos enlaces no funcionan hasta pasados unos segundos (YouTube da 403 antes)
    '-O', '%(title)s\t%(uploader)s\t%(duration)s\t%(available_at)s\t%(url)s',
    `https://www.youtube.com/watch?v=${id}`,
  ];
  return new Promise((resolve) => {
    execFile(path.join(BIN, 'yt-dlp'), args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const line = String(stdout || '').split('\n').find((l) => l.includes('\thttps://'));
      if (!line) {
        fs.rm(tmpCookies, { force: true }, () => {});
        if (fast) return resolve(runYtdlp(id, false, cookiesFile));
        const errLine = String(stderr || err?.message || '').split('\n').find((l) => l.includes('ERROR')) || 'sin enlace';
        const cookiesDead = /sign in to confirm|not a bot|cookies/i.test(errLine);
        if (cookiesDead && cookiesFile === COOKIES && fs.existsSync(BACKUP_COOKIES)) {
          console.warn(`[YT] Las cookies principales no sirven (${id}): se prueba con las de reserva`);
          reportCookiesExpired({ backupLeft: true });
          return resolve(runYtdlp(id, true, BACKUP_COOKIES));
        }
        console.warn(`[YT] No se pudo sacar el audio de ${id}:`, errLine);
        if (cookiesDead) reportCookiesExpired({ backupLeft: false });
        return resolve(null);
      }
      keepRenewedCookies(tmpCookies, cookiesFile);
      const [title, author, duration, availableAt, url] = line.split('\t');
      resolve({ title, author, duration: Math.round(Number(duration) * 1000) || 0, availableAt: (Number(availableAt) || 0) * 1000, url });
    });
  });
}

function queueYtdlp(id) {
  return new Promise((done) => {
    waiting.push({ id, done });
    pump();
  });
}

function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    running++;
    runYtdlp(job.id)
      .then(job.done)
      .finally(() => {
        running--;
        pump();
      });
  }
}

// Google renueva cada cierto tiempo algunas cookies de sesión: si yt-dlp funcionó, la copia que usó
// trae las renovadas y se guarda como la nueva (solo si sigue teniendo la sesión iniciada).
const SESSION_COOKIES = ['LOGIN_INFO', 'SID', '__Secure-3PSID'];
function keepRenewedCookies(tmpCookies, cookiesFile) {
  try {
    const text = fs.readFileSync(tmpCookies, 'utf8');
    const hasSession = SESSION_COOKIES.every((name) => text.split('\n').some((l) => l.split('\t')[5] === name));
    if (hasSession) {
      const staging = `${cookiesFile}.new`;
      fs.writeFileSync(staging, text, { mode: 0o600 });
      fs.renameSync(staging, cookiesFile);
    }
  } catch {
    // si falla, se queda el archivo anterior
  } finally {
    fs.rm(tmpCookies, { force: true }, () => {});
  }
}

// Aviso cuando YouTube deja de aceptar las cookies (como mucho una vez cada 6 h por tipo de aviso)
let onCookiesExpired = null;
const lastCookiesAlert = { true: 0, false: 0 };
function reportCookiesExpired({ backupLeft }) {
  if (!onCookiesExpired || Date.now() - lastCookiesAlert[backupLeft] < 6 * 3600 * 1000) return;
  lastCookiesAlert[backupLeft] = Date.now();
  Promise.resolve(onCookiesExpired({ backupLeft })).catch(() => {});
}
const setCookiesExpiredHandler = (fn) => {
  onCookiesExpired = fn;
};

// ── Descarga al disco ────────────────────────────────────────────────────────
/**
 * Una canción: datos (meta), tamaño total y cuánto hay ya escrito en disco.
 * ready: promesa que se cumple cuando se sabe el tamaño (ya se puede servir) o falla (false).
 */
const jobs = new Map(); // id -> job

function getRange(url, start, end, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { family: 4, headers: { Range: `bytes=${start}-${end}` }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(getRange(new URL(res.headers.location, url).toString(), start, end, redirects + 1));
      }
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function download(job, url, availableAt = 0) {
  const fd = await fs.promises.open(partPath(job.id), 'w', 0o600);
  try {
    let pos = 0;
    while (job.total === 0 || pos < job.total) {
      const end = job.total ? Math.min(pos + CHUNK, job.total) - 1 : pos + CHUNK - 1;
      let tries = 0;
      for (;;) {
        try {
          const res = await getRange(url, pos, end);
          if (!job.total) {
            const m = String(res.headers['content-range'] || '').match(/\/(\d+)$/);
            job.total = m ? Number(m[1]) : Number(res.headers['content-length']) || 0;
            if (!job.total) throw new Error('sin tamaño');
            job.emit('ready', true);
          }
          for await (const chunk of res) {
            await fd.write(chunk, 0, chunk.length, pos);
            pos += chunk.length;
            job.written = pos;
            job.emit('progress');
          }
          break;
        } catch (e) {
          // Enlace aún no disponible (403 hasta "available_at"): se reintenta cada segundo sin gastar intentos
          if (/HTTP 403/.test(e?.message) && Date.now() < availableAt + 8000) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          if (++tries >= 4) throw e;
          await new Promise((r) => setTimeout(r, 700 * tries));
        }
      }
    }
  } finally {
    await fd.close();
  }
  await fs.promises.rename(partPath(job.id), finalPath(job.id));
  job.file = finalPath(job.id);
  await fs.promises.writeFile(metaPath(job.id), JSON.stringify(job.meta));
  job.done = true;
  job.emit('progress');
  pruneCache().catch(() => {});
}

function cachedJob(id) {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    const size = fs.statSync(finalPath(id)).size;
    const now = new Date();
    fs.utimes(finalPath(id), now, now, () => {}); // para la limpieza: usado hace poco
    const job = Object.assign(new EventEmitter(), { id, meta, total: size, written: size, done: true, failed: false, file: finalPath(id) });
    job.setMaxListeners(0);
    job.ready = Promise.resolve(true);
    return job;
  } catch {
    return null;
  }
}

/** La canción (desde la caché del disco o empezando a descargarla). */
function getTrack(id) {
  if (!YT_ID_RE.test(id)) return null;
  const live = jobs.get(id);
  if (live && !live.failed) return live;
  const cached = cachedJob(id);
  if (cached) return cached;

  const job = Object.assign(new EventEmitter(), { id, meta: null, total: 0, written: 0, done: false, failed: false, file: partPath(id) });
  job.setMaxListeners(0); // cada lectura en curso escucha el progreso
  job.ready = new Promise((resolve) => job.once('ready', resolve));
  jobs.set(id, job);
  const fail = (why) => {
    if (job.failed) return;
    job.failed = true;
    if (why) console.warn(`[YT] Descarga fallida de ${id}:`, why);
    fs.rm(partPath(id), { force: true }, () => {});
    job.emit('ready', false);
    job.emit('progress');
    jobs.delete(id);
  };
  queueYtdlp(id).then((info) => {
    if (!info) return fail();
    job.meta = { title: info.title, author: info.author, duration: info.duration };
    job.emit('meta');
    download(job, info.url, info.availableAt)
      .then(() => setTimeout(() => jobs.get(id) === job && jobs.delete(id), 60_000))
      .catch((e) => fail(e?.message));
  });
  return job;
}

/** Datos del vídeo { title, author, duration } (para enlaces que el motor de audio no pudo leer). null si YouTube no lo da. */
async function videoInfo(id) {
  const job = getTrack(id);
  if (!job) return null;
  if (job.meta) return job.meta;
  if (job.failed) return null;
  await new Promise((resolve) => {
    job.once('meta', resolve);
    job.once('ready', resolve);
  });
  return job.meta;
}

/** Empieza a bajar la canción por adelantado (sin esperar). */
const prefetch = (id) => {
  if (id) getTrack(id);
};

/** Deja la caché por debajo del máximo, borrando lo que lleva más tiempo sin usarse. */
async function pruneCache() {
  const files = [];
  let total = 0;
  for (const f of await fs.promises.readdir(CACHE_DIR)) {
    if (!f.endsWith('.mp4')) continue;
    const st = await fs.promises.stat(path.join(CACHE_DIR, f)).catch(() => null);
    if (!st) continue;
    files.push({ id: f.slice(0, -4), size: st.size, at: st.mtimeMs });
    total += st.size;
  }
  files.sort((a, b) => a.at - b.at);
  for (const f of files) {
    if (total <= MAX_CACHE_BYTES) break;
    if (jobs.has(f.id)) continue;
    await fs.promises.rm(finalPath(f.id), { force: true });
    await fs.promises.rm(metaPath(f.id), { force: true });
    total -= f.size;
  }
}

// ── Servidor local para el motor de audio ────────────────────────────────────
/** Espera a que haya más datos descargados, o a que se cierre la conexión (lo que pase antes). */
const waitForData = (job, res) =>
  new Promise((resolve) => {
    if (res.destroyed) return resolve();
    const done = () => {
      job.off('progress', done);
      res.off('close', done);
      resolve();
    };
    job.on('progress', done);
    res.on('close', done);
  });

/** Espera a que la conexión acepte más datos, o a que se cierre (lo que pase antes). */
const waitForDrain = (res) =>
  new Promise((resolve) => {
    if (res.destroyed) return resolve();
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });

/** Envía los bytes [start, end] esperando a que la descarga los vaya escribiendo. */
async function streamRange(job, res, start, end) {
  let fd = null;
  try {
    let pos = start;
    while (!res.destroyed && pos <= end) {
      if (job.failed) throw new Error('descarga fallida');
      const available = job.done ? job.total : job.written;
      if (pos >= available) {
        await waitForData(job, res);
        continue;
      }
      // Si justo terminó y se renombró, se abre el archivo final
      if (!fd) fd = await fs.promises.open(job.file, 'r').catch(() => fs.promises.open(finalPath(job.id), 'r'));
      const len = Math.min(end + 1, available) - pos;
      const buf = Buffer.allocUnsafe(Math.min(len, 256 * 1024));
      const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
      if (!bytesRead) {
        await waitForData(job, res);
        continue;
      }
      pos += bytesRead;
      if (!res.write(buf.subarray(0, bytesRead))) await waitForDrain(res);
    }
    if (!res.destroyed) res.end();
  } catch {
    res.destroy();
  } finally {
    await fd?.close().catch(() => {});
  }
}

function startResolverServer() {
  const server = http.createServer(async (req, res) => {
    const m = String(req.url || '').match(/^\/yt\/([\w-]{11})(?:\?.*)?$/);
    const job = m && getTrack(m[1]);
    if (!job) {
      res.writeHead(404).end();
      return;
    }
    if (!(await job.ready) || !job.total) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end('YouTube no dio el audio');
      return;
    }
    const total = job.total;
    const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = total - 1;
    if (range) {
      if (range[1] === '' && range[2] !== '') start = Math.max(0, total - Number(range[2]));
      else {
        start = Number(range[1] || 0);
        if (range[2] !== '') end = Math.min(Number(range[2]), total - 1);
      }
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
    }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
    if (range) res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}` });
    else res.writeHead(200, headers);
    if (req.method === 'HEAD') return void res.end();
    streamRange(job, res, start, end);
  });
  server.listen(RESOLVER_PORT, '127.0.0.1', () => console.log(`[YT] Resolvedor de audio en 127.0.0.1:${RESOLVER_PORT}`));
  return server;
}

const localUrl = (id) => `http://127.0.0.1:${RESOLVER_PORT}/yt/${id}`;
const LOCAL_RE = new RegExp(`^http://127\\.0\\.0\\.1:${RESOLVER_PORT}/yt/([\\w-]{11})`);
/** id del vídeo si el enlace es del resolvedor local. */
const localId = (uri) => String(uri || '').match(LOCAL_RE)?.[1] || null;

// YouTube cambia a menudo: yt-dlp se actualiza solo al arrancar y una vez al día
function selfUpdate() {
  execFile(path.join(BIN, 'yt-dlp'), ['-U'], { timeout: 120000 }, (err, stdout) => {
    const msg = String(stdout || '').split('\n').filter(Boolean).pop();
    if (msg) console.log('[YT] yt-dlp:', msg);
  });
}
setTimeout(selfUpdate, 60 * 1000).unref();
setInterval(selfUpdate, 24 * 3600 * 1000).unref();

module.exports = { setCookiesExpiredHandler, videoInfo, prefetch, startResolverServer, localUrl, localId, YT_ID_RE };
