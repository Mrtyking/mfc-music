// Playlists de cada usuario (sus canciones favoritas), guardadas en data/playlists.json.
// Se escribe primero en un archivo temporal y luego se renombra: un reinicio a mitad de guardado no lo corrompe.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'playlists.json');

const MAX_LISTS = 10; // playlists por usuario
const MAX_TRACKS = 100; // canciones por playlist
const MAX_NAME = 32;
const FAVORITES = 'Favoritas';

fs.mkdirSync(DATA_DIR, { recursive: true });

/** { [userId]: [{ id, name, tracks: [...], createdAt, updatedAt }] } */
let db = {};
try {
  db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  db = {};
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error('[PLAYLISTS] No se pudo guardar:', e?.message);
    }
  }, 300);
}
// Al apagar el bot se guarda lo pendiente al momento
process.once('SIGINT', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    try {
      fs.writeFileSync(FILE, JSON.stringify(db));
    } catch {}
  }
  process.exit(0);
});

const cleanName = (name) => String(name || '').replace(/[`*_~|<>@#]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
const sameName = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }) === 0;

const listsOf = (userId) => db[userId] || [];

/** Busca por nombre (sin distinguir mayúsculas ni tildes) o por id. */
function find(userId, nameOrId) {
  const key = cleanName(nameOrId);
  return listsOf(userId).find((l) => l.id === nameOrId || sameName(l.name, key)) || null;
}

/** Crea una playlist. Devuelve { list } o { error }. */
function create(userId, name) {
  const n = cleanName(name);
  if (!n) return { error: 'Ponle un nombre a la playlist.' };
  const existing = find(userId, n);
  if (existing) return { error: `Ya tienes una playlist llamada **${existing.name}**.` };
  if (listsOf(userId).length >= MAX_LISTS) return { error: `Ya tienes ${MAX_LISTS} playlists (el máximo). Borra alguna para crear otra.` };
  const list = { id: crypto.randomBytes(4).toString('hex'), name: n, tracks: [], createdAt: Date.now(), updatedAt: Date.now() };
  db[userId] = [...listsOf(userId), list];
  save();
  return { list };
}

/** La playlist con ese nombre; si es "Favoritas" (o no se dio nombre) y no existe, se crea. */
function findOrFavorites(userId, name) {
  const n = cleanName(name) || FAVORITES;
  const found = find(userId, n);
  if (found) return { list: found };
  if (sameName(n, FAVORITES)) return create(userId, FAVORITES);
  return { error: `No tienes ninguna playlist llamada **${n}**. Créala con \`/playlist crear\`.` };
}

/** Añade canciones (sin repetir). Devuelve { added, duplicates, full }. */
function addTracks(list, tracks) {
  let added = 0;
  let duplicates = 0;
  let full = 0;
  for (const t of tracks) {
    if (!t) continue;
    const dup = list.tracks.some((x) => (t.yt && x.yt === t.yt) || (!t.yt && x.uri === t.uri));
    if (dup) {
      duplicates++;
      continue;
    }
    if (list.tracks.length >= MAX_TRACKS) {
      full++;
      continue;
    }
    list.tracks.push({ ...t, addedAt: Date.now() });
    added++;
  }
  if (added) {
    list.updatedAt = Date.now();
    save();
  }
  return { added, duplicates, full };
}

/** Quita la canción en la posición (1, 2, 3…). Devuelve la canción quitada o null. */
function removeTrack(list, position) {
  const i = Number(position) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= list.tracks.length) return null;
  const [removed] = list.tracks.splice(i, 1);
  list.updatedAt = Date.now();
  save();
  return removed;
}

function removeList(userId, list) {
  db[userId] = listsOf(userId).filter((l) => l.id !== list.id);
  if (!db[userId].length) delete db[userId];
  save();
}

function rename(userId, list, newName) {
  const n = cleanName(newName);
  if (!n) return { error: 'Ponle un nombre nuevo.' };
  const other = find(userId, n);
  if (other && other.id !== list.id) return { error: `Ya tienes una playlist llamada **${n}**.` };
  list.name = n;
  list.updatedAt = Date.now();
  save();
  return { list };
}

module.exports = { MAX_LISTS, MAX_TRACKS, FAVORITES, listsOf, find, create, findOrFavorites, addTracks, removeTrack, removeList, rename };
