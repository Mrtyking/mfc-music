// Lógica de reproducción: elegir bot, buscar, cola, panel y salida automática.
const cfg = require('./config');
const ui = require('./ui');
const { units, unitInChannel, freeUnitFor } = require('./pool');
const { isSpotify, spotifyToQuery } = require('./spotify');
const yt = require('./youtube');
const { MAX_TRACKS: PLAYLIST_MAX } = require('./playlists');

const URL_RE = /^https?:\/\//i;
const youtubeId = (u) => u.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/i)?.[1] || null;
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Título de un vídeo de YouTube (funciona aunque el vídeo tenga restricción de edad). */
async function youtubeTitle(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    // Se quita lo que estorba en la búsqueda: (video oficial), [Official Video], comillas…
    return String(j.title || '').replace(/[\(\[][^\)\]]*(oficial|official|video|lyric|letra|audio|visualizer)[^\)\]]*[\)\]]/gi, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim() || null;
  } catch {
    return null;
  }
}
/**
 * Las canciones de YouTube no se reproducen directo (YouTube bloquea al servidor): se ponen en la cola
 * como pendientes con el enlace del resolvedor local, que entrega el audio real con yt-dlp.
 */
function viaResolver(unit, track, requester) {
  if (track?.info?.sourceName !== 'youtube' || !yt.YT_ID_RE.test(track.info.identifier || '')) return track;
  const id = track.info.identifier;
  return unit.manager.utils.buildUnresolvedTrack(
    {
      title: track.info.title,
      author: track.info.author,
      duration: track.info.duration,
      artworkUrl: track.info.artworkUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      uri: yt.localUrl(id),
      sourceName: 'youtube',
      isStream: !!track.info.isStream,
    },
    requester
  );
}

/** Canción de YouTube armada solo con yt-dlp (cuando el motor de audio no puede ni leer el enlace). */
async function ytFromLink(unit, id, requester) {
  const info = await yt.videoInfo(id);
  if (!info) return null;
  return unit.manager.utils.buildUnresolvedTrack(
    { title: info.title, author: info.author, duration: info.duration, artworkUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, uri: yt.localUrl(id), sourceName: 'youtube' },
    requester
  );
}

const emptyTimers = new Map(); // `${unitIndex}:${guildId}` -> timeout

const main = () => units[0];

/** Canal de voz donde está el usuario (según el bot principal, que ve todos los estados de voz). */
function voiceChannelOf(guildId, userId) {
  return main().client.guilds.cache.get(guildId)?.voiceStates.cache.get(userId)?.channelId || null;
}

/** Busca la canción. Texto → YouTube (y SoundCloud si no hay nada). Spotify → nombre + artista en YouTube. */
async function resolve(unit, player, query, requester) {
  let q = query.trim();
  if (isSpotify(q)) {
    const asText = await spotifyToQuery(q);
    if (!asText) return { error: 'Solo se pueden poner canciones sueltas de Spotify (no listas ni álbumes), o el enlace no es válido.' };
    q = asText;
  }
  const tries = URL_RE.test(q) ? [{ query: q }] : [{ query: q, source: 'ytsearch' }, { query: q, source: 'scsearch' }];
  for (const t of tries) {
    const res = await player.search(t, requester).catch((e) => ({ loadType: 'error', exception: { message: e?.message } }));
    if (res?.tracks?.length && res.loadType !== 'error' && res.loadType !== 'empty') return { res };
  }
  // Enlace de YouTube que el motor de audio no pudo leer: se saca directo con yt-dlp
  const ytId = youtubeId(q);
  if (ytId) {
    const direct = await ytFromLink(unit, ytId, requester);
    if (direct) return { res: { loadType: 'track', tracks: [direct] } };
  }
  // Si tampoco (restricción de edad, privado en la región…): se busca la misma canción por su título
  if (ytId) {
    const title = await youtubeTitle(ytId);
    if (title) {
      for (const source of ['ytsearch', 'scsearch']) {
        const res = await player.search({ query: title, source }, requester).catch(() => null);
        // Solo una versión fiable: mismas palabras (artista + nombre) y que no sea reacción, cover, karaoke…
        const words = norm(title).split(' ').filter((w) => w.length > 1);
        const tracks = (res?.tracks || []).filter((t) => {
          if (t.info?.identifier === ytId) return false;
          const hay = norm(`${t.info.title} ${t.info.author}`);
          return words.every((w) => hay.includes(w)) && !/reacci|reaction|react|cover|karaoke|instrumental|remix|slowed|sped|nightcore|tutorial/.test(hay);
        });
        if (tracks.length) return { res: { ...res, loadType: 'track', tracks: [tracks[0]] }, note: 'Ese vídeo tiene restricción de edad en YouTube: puse otra versión de la misma canción.' };
      }
    }
    return { error: 'Ese vídeo de YouTube no se puede reproducir (tiene restricción de edad o está bloqueado) y no encontré otra versión. Prueba con el nombre de la canción.' };
  }
  return { error: 'No encontré nada con eso. Prueba con otro nombre o con el enlace de YouTube.' };
}

/**
 * /play: elige bot, busca la canción y la añade a la cola.
 * reply(payload) envía la respuesta (al slash o al canal). Devuelve el payload de respuesta.
 */
async function play({ guildId, userId, query, textChannelId }) {
  if (!query?.trim()) return ui.notice('Falta la canción', 'Escribe el nombre o el enlace en `/play`.');
  const joined = await joinUserChannel({ guildId, userId, textChannelId });
  if (joined.error) return joined.error;
  const { unit, player, fresh } = joined;

  const requester = { id: userId };
  const { res, error, note } = await resolve(unit, player, query, requester);
  if (error) {
    if (fresh && !player.queue.current && !player.queue.tracks.length) await player.destroy('no-results').catch(() => {});
    return ui.notice('Sin resultados', error, 0xf59e0b);
  }

  const isList = res.loadType === 'playlist';
  const tracks = (isList ? res.tracks.slice(0, cfg.MAX_PLAYLIST) : [res.tracks[0]]).map((t) => viaResolver(unit, t, requester));
  const { error: full, added, willStart } = await enqueue(unit, player, tracks, userId, textChannelId);
  if (full) return full;

  // El panel ya muestra la canción cuando arranca; aquí solo se confirma lo añadido
  const view = ui.addedView(unit, player, { tracks: added, playlist: isList ? res.playlist : null }, willStart);
  if (note) view.components[0].components.push({ type: 10, content: `-# ${note}` });
  return view;
}

/**
 * Elige bot para el canal de voz del usuario y lo conecta.
 * 1) Ya hay un bot en su canal → ese. 2) Si no, el primer bot libre. 3) Si no hay, aviso (error).
 */
async function joinUserChannel({ guildId, userId, textChannelId }) {
  const vc = voiceChannelOf(guildId, userId);
  if (!vc) return { error: ui.notice('Entra a un canal de voz', 'Tienes que estar en un canal de voz para pedir música.') };

  let unit = unitInChannel(guildId, vc);
  let fresh = false;
  if (!unit) {
    unit = freeUnitFor(guildId, vc);
    if (!unit) {
      const busy = ui.notice('Todos los bots están ocupados', 'Los bots de música están en otros canales ahora mismo. Únete a uno de esos canales o espera a que alguno quede libre.', 0xf59e0b);
      return { error: { ...busy, components: [...busy.components, ...ui.botsView(units, guildId).components] } };
    }
    fresh = true;
  }

  let player = unit.manager.players.get(guildId);
  if (!player) {
    player = unit.manager.createPlayer({ guildId, voiceChannelId: vc, textChannelId, selfDeaf: true, volume: cfg.DEFAULT_VOLUME });
  }
  if (textChannelId) player.textChannelId = textChannelId;
  if (!player.connected) await player.connect();
  return { unit, player, fresh };
}

/** Añade canciones a la cola (con los límites por persona) y arranca si no sonaba nada. */
async function enqueue(unit, player, tracks, userId, textChannelId, perUserMax = cfg.MAX_PER_USER) {
  // Límites para que nadie llene la cola él solo (las playlists propias entran completas)
  const mine = player.queue.tracks.filter((t) => t.requester?.id === userId).length;
  const room = Math.min(cfg.MAX_QUEUE - player.queue.tracks.length, perUserMax - mine);
  if (room <= 0) return { error: ui.notice('Cola llena', `Ya tienes ${mine} canciones en cola (máximo ${perUserMax} por persona).`, 0xf59e0b) };
  const added = tracks.slice(0, room);
  // Se prepara el audio ya: la primera (o la siguiente en cola) sin esperar
  prefetchUpcoming(player, added.slice(0, 2));

  const willStart = !player.playing && !player.paused && !player.queue.current;
  await player.queue.add(added);
  // No se espera a que arranque (la primera vez YouTube tarda unos segundos): se responde ya y el panel
  // aparece solo cuando empieza a sonar
  if (willStart)
    player.play({ paused: false }).catch((e) => {
      console.warn('[MUSIC] No se pudo empezar a reproducir:', e?.message);
      main()
        .client.channels.cache.get(textChannelId)
        ?.send(ui.notice('No se pudo reproducir', 'La canción no se pudo cargar. Prueba con otra o vuelve a intentarlo.', 0xf59e0b))
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 15000))
        .catch(() => {});
    });
  clearEmptyTimer(unit, player.guildId);
  return { added, willStart, skipped: tracks.length - added.length };
}

/** Pone en la cola toda una playlist guardada, siempre mezclada (las de YouTube entran al instante, sin volver a buscarlas). */
async function playSaved({ guildId, userId, textChannelId, list }) {
  if (!list?.tracks?.length) return ui.notice('Playlist vacía', 'Esa playlist no tiene canciones todavía.', 0xf59e0b);
  const joined = await joinUserChannel({ guildId, userId, textChannelId });
  if (joined.error) return joined.error;
  const { unit, player } = joined;

  const requester = { id: userId };
  const saved = [...list.tracks];
  for (let i = saved.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [saved[i], saved[j]] = [saved[j], saved[i]];
  }
  const tracks = saved.map((s) => fromSaved(unit, s, requester)).filter(Boolean);
  const { error: full, added, willStart, skipped } = await enqueue(unit, player, tracks, userId, textChannelId, cfg.MAX_PER_USER + PLAYLIST_MAX);
  if (full) return full;
  return ui.savedQueuedView(unit, player, list, added, { willStart, skipped });
}

/** Canción guardada → canción de la cola. */
function fromSaved(unit, s, requester) {
  try {
    if (s.yt && yt.YT_ID_RE.test(s.yt)) {
      return unit.manager.utils.buildUnresolvedTrack(
        { title: s.title, author: s.author, duration: s.duration, artworkUrl: `https://i.ytimg.com/vi/${s.yt}/hqdefault.jpg`, uri: yt.localUrl(s.yt), sourceName: 'youtube' },
        requester
      );
    }
    if (!s.uri) return null;
    return unit.manager.utils.buildUnresolvedTrack({ title: s.title, author: s.author, duration: s.duration, uri: s.uri, sourceName: s.source }, requester);
  } catch {
    return null;
  }
}

/** Canción de la cola → lo que se guarda en una playlist. */
function toSaved(t) {
  if (!t?.info) return null;
  const ytId = yt.localId(t.info.uri) || (t.info.sourceName === 'youtube' ? t.info.identifier : null);
  const base = { title: String(t.info.title || 'Sin título').slice(0, 150), author: String(t.info.author || '').slice(0, 80), duration: Number(t.info.duration) || 0 };
  if (ytId && yt.YT_ID_RE.test(ytId)) return { ...base, yt: ytId, uri: `https://www.youtube.com/watch?v=${ytId}`, source: 'youtube' };
  if (!t.info.uri || /^http:\/\/127\./.test(t.info.uri)) return null;
  return { ...base, uri: t.info.uri, source: t.info.sourceName || 'http' };
}

/** Canción que suena ahora en el canal del usuario (o en el bot del panel). */
function currentTrackFor(guildId, userId, unitIndex) {
  const unit = unitIndex !== undefined && units[unitIndex] ? units[unitIndex] : unitInChannel(guildId, voiceChannelOf(guildId, userId));
  return unit?.manager.players.get(guildId)?.queue.current || null;
}

/** Cola completa (actual + siguientes) del canal del usuario. */
function queueFor(guildId, userId) {
  const unit = unitInChannel(guildId, voiceChannelOf(guildId, userId));
  const p = unit?.manager.players.get(guildId);
  return p ? [p.queue.current, ...p.queue.tracks].filter(Boolean) : [];
}

/** Busca una canción para guardarla (sin reproducirla). */
async function searchOne(query) {
  const unit = units.find((u) => u.ready);
  const node = unit?.manager.nodeManager.leastUsedNodes()[0];
  if (!node) return null;
  let q = query.trim();
  if (isSpotify(q)) q = (await spotifyToQuery(q)) || '';
  if (!q) return null;
  const ytId = youtubeId(q);
  if (ytId) {
    const info = await yt.videoInfo(ytId);
    return info ? { title: info.title, author: info.author, duration: info.duration, yt: ytId, uri: `https://www.youtube.com/watch?v=${ytId}`, source: 'youtube' } : null;
  }
  const res = await node.search(URL_RE.test(q) ? { query: q } : { query: q, source: 'ytsearch' }, { id: 'playlist' }).catch(() => null);
  return toSaved(res?.tracks?.[0]);
}

/** Prepara por adelantado el audio de YouTube de las próximas canciones. */
function prefetchUpcoming(player, extra = []) {
  for (const t of [...player.queue.tracks.slice(0, 2), ...extra]) yt.prefetch(yt.localId(t?.info?.uri));
}

/** Bot que está en el canal de voz del usuario (para los controles). */
function controlledUnit(guildId, userId, unitIndex) {
  const vc = voiceChannelOf(guildId, userId);
  const unit = unitIndex !== undefined ? units[unitIndex] : unitInChannel(guildId, vc);
  const player = unit?.manager.players.get(guildId);
  if (!unit || !player) return { error: ui.notice('No hay música aquí', 'No hay ningún bot de música en tu canal de voz.', 0xf59e0b) };
  if (!vc || player.voiceChannelId !== vc) return { error: ui.notice('Únete al canal', `Para controlar esta música tienes que estar en <#${player.voiceChannelId}>.`, 0xf59e0b) };
  return { unit, player };
}

/** Controles: skip, stop, pause, resume, loop, shuffle, volume, leave. */
async function control(action, { guildId, userId, unitIndex, value }) {
  const { unit, player, error } = controlledUnit(guildId, userId, unitIndex);
  if (error) return { reply: error };
  switch (action) {
    case 'skip':
      if (!player.queue.current) return { reply: ui.notice('Nada sonando', 'No hay ninguna canción que saltar.') };
      if (!player.queue.tracks.length) {
        await player.stopPlaying(true, false);
        return { reply: ui.notice('Saltada', 'Era la última canción de la cola.'), refresh: true, unit, player };
      }
      await player.skip();
      return { reply: ui.notice('Saltada', 'Pasando a la siguiente canción.'), unit, player };
    case 'stop':
      await player.destroy('stopped-by-user');
      return { reply: ui.notice('Música detenida', `**${ui.clean(unit.name)}** salió del canal y queda libre.`), unit };
    case 'leave':
      await player.destroy('left-by-user');
      return { reply: ui.notice('Fuera del canal', `**${ui.clean(unit.name)}** queda libre para otro canal.`), unit };
    case 'pause':
      if (player.paused) await player.resume();
      else await player.pause();
      return { reply: ui.notice(player.paused ? 'En pausa' : 'Reanudada', player.paused ? 'La música está en pausa.' : 'La música sigue.'), refresh: true, unit, player };
    case 'resume':
      if (player.paused) await player.resume();
      return { reply: ui.notice('Reanudada', 'La música sigue.'), refresh: true, unit, player };
    case 'loop': {
      const next = { off: 'track', track: 'queue', queue: 'off' }[player.repeatMode] || 'off';
      await player.setRepeatMode(next);
      return { reply: ui.notice('Repetir', { off: 'Desactivado.', track: 'Se repite la canción actual.', queue: 'Se repite toda la cola.' }[next]), refresh: true, unit, player };
    }
    case 'shuffle':
      if (player.queue.tracks.length < 2) return { reply: ui.notice('Mezclar', 'Hacen falta al menos 2 canciones en cola.') };
      await player.queue.shuffle();
      return { reply: ui.notice('Cola mezclada', `${player.queue.tracks.length} canciones en orden aleatorio.`), refresh: true, unit, player };
    case 'volume': {
      const v = Math.max(0, Math.min(150, Math.round(Number(value))));
      if (!Number.isFinite(v)) return { reply: ui.notice('Volumen', `Volumen actual: ${player.volume}%. Usa \`/volume\`.`) };
      await player.setVolume(v);
      return { reply: ui.notice('Volumen', `Volumen al ${v}%.`), refresh: true, unit, player };
    }
    case 'volup':
    case 'voldown':
      await player.setVolume(Math.max(10, Math.min(150, player.volume + (action === 'volup' ? 10 : -10))));
      return { reply: ui.notice('Volumen', `Volumen al ${player.volume}%.`), refresh: true, unit, player };
    case 'queue':
      return { reply: ui.queueView(player, unit) };
    case 'np':
      return { reply: ui.playerPanel(player, unit) };
    default:
      return { reply: ui.notice('Comando desconocido', 'Usa `/musica` para ver los comandos.') };
  }
}

// ── Panel del reproductor (lo publica siempre el bot principal) ───────────────
async function sendOrEditPanel(unit, player, opts = {}) {
  const channelId = player.textChannelId;
  if (!channelId) return;
  const channel = main().client.channels.cache.get(channelId) || (await main().client.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased?.()) return;
  const payload = ui.playerPanel(player, unit, opts);
  const oldId = player.get('panelId');
  if (oldId && !opts.newMessage) {
    const old = await channel.messages.fetch(oldId).catch(() => null);
    if (old) {
      await old.edit(payload).catch(() => {});
      return;
    }
  }
  // Canción nueva: se borra el panel anterior y se manda uno nuevo al final del chat
  if (oldId) channel.messages.delete(oldId).catch(() => {});
  const msg = await channel.send(payload).catch((e) => console.error('[MUSIC PANEL]', e?.message));
  if (msg) player.set('panelId', msg.id);
}

async function closePanel(player) {
  const id = player.get('panelId');
  const ch = player.textChannelId && main().client.channels.cache.get(player.textChannelId);
  if (id && ch) ch.messages.delete(id).catch(() => {});
}

function clearEmptyTimer(unit, guildId) {
  const k = `${unit.index}:${guildId}`;
  if (emptyTimers.has(k)) {
    clearTimeout(emptyTimers.get(k));
    emptyTimers.delete(k);
  }
}

/** Si un bot se queda solo en su canal, se va al minuto (queda libre para otro canal). */
function checkEmptyChannels(guildId) {
  const guild = main().client.guilds.cache.get(guildId);
  if (!guild) return;
  for (const unit of units) {
    const player = unit.manager.players.get(guildId);
    if (!player?.voiceChannelId) continue;
    const humans = guild.voiceStates.cache.filter((vs) => vs.channelId === player.voiceChannelId && !vs.member?.user?.bot).size;
    const k = `${unit.index}:${guildId}`;
    if (humans === 0 && !emptyTimers.has(k)) {
      emptyTimers.set(
        k,
        setTimeout(async () => {
          emptyTimers.delete(k);
          const p = unit.manager.players.get(guildId);
          if (!p) return;
          const still = guild.voiceStates.cache.filter((vs) => vs.channelId === p.voiceChannelId && !vs.member?.user?.bot).size;
          if (still === 0) await p.destroy('empty-channel').catch(() => {});
        }, cfg.EMPTY_LEAVE_MS)
      );
    } else if (humans > 0) clearEmptyTimer(unit, guildId);
  }
}

/** Eventos de Lavalink de cada bot. */
function wireEvents(unit) {
  const m = unit.manager;
  m.on('trackStart', (player) => {
    sendOrEditPanel(unit, player, { newMessage: true });
    prefetchUpcoming(player);
  });
  m.on('queueEnd', (player) => sendOrEditPanel(unit, player, { ended: true }));
  m.on('playerDestroy', (player) => {
    clearEmptyTimer(unit, player.guildId);
    closePanel(player);
  });
  m.on('trackError', (player, track, payload) => {
    console.warn(`[MUSIC] Error en ${track?.info?.title}:`, payload?.exception?.message);
    const ch = player.textChannelId && main().client.channels.cache.get(player.textChannelId);
    if (ch)
      ch.send(ui.notice('No se pudo reproducir', `**${ui.clean(track?.info?.title || 'La canción')}** dio un error y se saltó. Prueba con otro enlace.`, 0xf59e0b))
        .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 15000))
        .catch(() => {});
  });
  m.on('trackStuck', (player) => player.skip().catch(() => {}));
}

module.exports = { play, playSaved, toSaved, currentTrackFor, queueFor, searchOne, control, sendOrEditPanel, checkEmptyChannels, wireEvents, voiceChannelOf };
