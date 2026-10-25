// Mensajes del bot de música en Discord Components V2. Los iconos son emojis de aplicación (ver icons.js).
const { MessageFlags } = require('discord.js');
const { COLOR } = require('./config');
const { localId } = require('./youtube');
const { tag, em } = require('./icons');

const V2 = MessageFlags.IsComponentsV2;
const NO_PINGS = { parse: [] };

const text = (content) => ({ type: 10, content: String(content).slice(0, 3900) });
const sep = (big = false) => ({ type: 14, divider: true, spacing: big ? 2 : 1 });
const container = (components, color = COLOR) => ({ type: 17, accent_color: color, components });
const section = (lines, thumbUrl) =>
  thumbUrl
    ? { type: 9, components: [text(lines)], accessory: { type: 11, media: { url: thumbUrl } } }
    : text(lines);
const button = (custom_id, label, style = 2, disabled = false, icon) => ({ type: 2, style, custom_id, ...(label ? { label } : {}), ...(icon ? { emoji: em(icon) } : {}), disabled });
const row = (...buttons) => ({ type: 1, components: buttons });

const clean = (s, max = 90) => String(s || '').replace(/[*_`~|\[\]]/g, '').slice(0, max);

const fmtTime = (ms) => {
  if (!ms || ms < 0 || !Number.isFinite(ms)) return 'En directo';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const SOURCE = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', bandcamp: 'Bandcamp', vimeo: 'Vimeo', http: 'Enlace' };
// Las canciones de YouTube suenan por el resolvedor local: se muestra el vídeo original
const ytIdOf = (t) => localId(t?.info?.uri) || (t?.info?.sourceName === 'youtube' ? t.info.identifier : null);
const sourceName = (t) => (localId(t?.info?.uri) ? 'YouTube' : SOURCE[t?.info?.sourceName] || 'Música');
const trackUrl = (t) => {
  const id = localId(t?.info?.uri);
  return id ? `https://www.youtube.com/watch?v=${id}` : t?.info?.uri;
};
const trackLink = (t) => (trackUrl(t) ? `[${clean(t.info.title, 80)}](${trackUrl(t)})` : `**${clean(t.info.title, 80)}**`);
const artwork = (t) => t?.info?.artworkUrl || (ytIdOf(t) ? `https://i.ytimg.com/vi/${ytIdOf(t)}/hqdefault.jpg` : null);
const REPEAT = { off: 'No', track: 'Canción', queue: 'Cola' };

// Icono del aviso según su título (si ninguno encaja: advertencia en ámbar, información en el resto)
const NOTICE_ICONS = [
  [/saltada/i, 'ms_skip'], [/en pausa/i, 'ms_pause'], [/reanudada/i, 'ms_play'], [/detenida/i, 'ms_stop'], [/fuera del canal/i, 'ms_leave'],
  [/repetir/i, 'ms_repeat_on'], [/mezcl/i, 'ms_shuffle'], [/volumen/i, 'ms_volup'], [/guardada|creada|renombrada/i, 'ms_ok'],
  [/quitada|borrada/i, 'ms_trash'], [/cookies|dej[oó] de funcionar/i, 'ms_cookie'], [/ocupados/i, 'ms_bots'], [/voz|canal/i, 'ms_voice'],
  [/cola llena|playlist llena|vac[ií]a|no existe|no se pudo|sin resultados|n[uú]mero|algo fall|no es tuya|ya no existe|nada/i, 'ms_warn'],
];
const noticeIcon = (title, color) => {
  const hit = NOTICE_ICONS.find(([re]) => re.test(title));
  return hit ? hit[1] : color === 0xf59e0b ? 'ms_warn' : 'ms_info';
};

/** Aviso corto (éxito, error o información). */
function notice(title, body, color = COLOR) {
  return { flags: V2, allowedMentions: NO_PINGS, components: [container([text(`### ${tag(noticeIcon(title, color))} ${title}\n${body}`)], color)] };
}

/** Panel del reproductor: canción actual, siguiente, estado y botones. */
function playerPanel(player, unit, { ended = false } = {}) {
  const t = player.queue.current;
  const u = unit.index;
  if (!t || ended) {
    return {
      flags: V2,
      allowedMentions: NO_PINGS,
      components: [
        container(
          [
            text(`### ${tag('ms_stop')} Cola terminada\n**${clean(unit.name)}** queda libre en <#${player.voiceChannelId}> durante unos minutos.\nPide otra con \`/play\`.`),
            sep(),
            row(button(`mus:leave:${u}`, 'Salir del canal', 4, false, 'ms_leave')),
          ],
          0x52525b
        ),
      ],
    };
  }
  const next = player.queue.tracks[0];
  const req = t.requester?.id ? `<@${t.requester.id}>` : 'alguien';
  const head = [
    `-# ${tag(player.paused ? 'ms_pause' : 'ms_play')} ${player.paused ? 'EN PAUSA' : 'REPRODUCIENDO'} · ${sourceName(t)}`,
    `### ${trackLink(t)}`,
    `${clean(t.info.author, 60)} · ${fmtTime(t.info.duration)}`,
    `${tag('ms_user')} ${req} · ${tag('ms_voice')} <#${player.voiceChannelId}>`,
  ].join('\n');
  const info = [
    next ? `${tag('ms_next')} **Siguiente:** ${trackLink(next)} · ${fmtTime(next.info.duration)}` : `${tag('ms_next')} **Siguiente:** nada en cola`,
    `-# ${player.queue.tracks.length} en cola · Volumen ${player.volume}% · Repetir: ${REPEAT[player.repeatMode] || 'No'} · Bot: ${clean(unit.name, 30)}`,
  ].join('\n');
  return {
    flags: V2,
    allowedMentions: NO_PINGS,
    components: [
      container([
        section(head, artwork(t)),
        sep(),
        text(info),
        row(
          button(`mus:pause:${u}`, '', player.paused ? 3 : 2, false, player.paused ? 'ms_play' : 'ms_pause'),
          button(`mus:skip:${u}`, '', 1, false, 'ms_skip'),
          button(`mus:stop:${u}`, '', 4, false, 'ms_stop'),
          button(`mus:loop:${u}`, `Repetir: ${REPEAT[player.repeatMode] || 'No'}`, player.repeatMode && player.repeatMode !== 'off' ? 3 : 2, false, player.repeatMode === 'track' ? 'ms_repeat1' : player.repeatMode === 'queue' ? 'ms_repeat_on' : 'ms_repeat'),
          button(`mus:shuffle:${u}`, '', 2, player.queue.tracks.length < 2, 'ms_shuffle')
        ),
        row(
          button(`mus:queue:${u}`, 'Ver cola', 2, false, 'ms_queue'),
          button(`mus:voldown:${u}`, '', 2, player.volume <= 10, 'ms_voldown'),
          button(`mus:volup:${u}`, '', 2, player.volume >= 150, 'ms_volup'),
          button(`mus:save:${u}`, 'Guardar en favoritas', 3, false, 'ms_heart')
        ),
      ]),
    ],
  };
}

/** Lista de la cola (solo la ve quien la pide). */
function queueView(player, unit) {
  const t = player.queue.current;
  const list = player.queue.tracks.slice(0, 15).map((x, i) => `\`${String(i + 1).padStart(2, '0')}\` ${trackLink(x)} · ${fmtTime(x.info.duration)}`);
  const total = player.queue.tracks.reduce((a, x) => a + (x.info.duration || 0), 0);
  return {
    flags: V2 | MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
    components: [
      container([
        text(`### ${tag('ms_queue')} Cola de ${clean(unit.name, 30)} · <#${player.voiceChannelId}>`),
        sep(),
        text(t ? `${tag('ms_play')} **Ahora:** ${trackLink(t)} · ${fmtTime(t.info.duration)}` : `${tag('ms_play')} **Ahora:** nada`),
        text(list.length ? list.join('\n') : 'No hay más canciones en cola.'),
        ...(player.queue.tracks.length > 15 ? [text(`-# y ${player.queue.tracks.length - 15} más`)] : []),
        sep(),
        text(`-# ${player.queue.tracks.length} canciones · ${fmtTime(total)} en total`),
      ]),
    ],
  };
}

/** Aviso al añadir canciones a la cola. */
function addedView(unit, player, { tracks, playlist }, startedNow) {
  const t = tracks[0];
  const body = playlist
    ? `Lista **${clean(playlist.name || playlist.title, 80)}**: ${tracks.length} canciones añadidas.`
    : startedNow
      ? `${trackLink(t)} · ${fmtTime(t.info.duration)}\nEmpieza a sonar en unos segundos.`
      : `${trackLink(t)} · ${fmtTime(t.info.duration)}\nPosición en la cola: **${player.queue.tracks.length}**`;
  return {
    flags: V2,
    allowedMentions: NO_PINGS,
    components: [
      container([
        section(`### ${tag(startedNow && !playlist ? 'ms_music' : 'ms_add')} ${startedNow && !playlist ? 'Preparando tu canción' : 'Añadida a la cola'}\n${body}\n-# ${clean(unit.name, 30)} en <#${player.voiceChannelId}>`, artwork(t)),
      ]),
    ],
  };
}

/** Estado de todos los bots. */
function botsView(units, guildId) {
  const lines = units.map((u) => {
    const p = u.manager?.players.get(guildId);
    const status = !u.ready ? 'Desconectado' : p?.voiceChannelId ? `En <#${p.voiceChannelId}>${p.queue.current ? ` · ${clean(p.queue.current.info.title, 40)}` : ''}` : 'Libre';
    return `**${clean(u.name, 30)}** · ${status}`;
  });
  const free = units.filter((u) => u.ready && !u.manager?.players.get(guildId)?.voiceChannelId).length;
  return {
    flags: V2,
    allowedMentions: NO_PINGS,
    components: [container([text(`### ${tag('ms_bots')} Bots de música\n${free} de ${units.length} libres`), sep(), text(lines.join('\n'))])],
  };
}

// ── Playlists ────────────────────────────────────────────────────────────────
const savedLink = (t) => (t.uri ? `[${clean(t.title, 70)}](${t.uri})` : `**${clean(t.title, 70)}**`);
const totalTime = (tracks) => fmtTime(tracks.reduce((a, t) => a + (t.duration || 0), 0) || -1).replace('En directo', '0:00');
const PAGE = 15;

/** Todas las playlists del usuario. */
function playlistsOverview(lists, { max }) {
  const lines = lists.map((l) => `**${clean(l.name, 32)}** · ${l.tracks.length} canciones · ${totalTime(l.tracks)}`);
  return {
    flags: V2 | MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
    components: [
      container([
        text(`### ${tag('ms_playlist')} Tus playlists\n-# ${lists.length} de ${max}`),
        sep(),
        text(
          lines.length
            ? lines.join('\n')
            : 'Todavía no tienes playlists.\n\nPulsa **Guardar en favoritas** en el panel de música mientras suena una canción, o crea una con `/playlist crear`.'
        ),
        sep(),
        text('-# `/playlist ver` con el nombre para ver sus canciones · `/playplaylist` para ponerla en cola'),
      ]),
    ],
  };
}

/** Canciones de una playlist (con páginas y botones para reproducir). */
function playlistView(list, userId, page = 0) {
  const pages = Math.max(1, Math.ceil(list.tracks.length / PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.tracks.slice(p * PAGE, p * PAGE + PAGE);
  const lines = slice.map((t, i) => `\`${String(p * PAGE + i + 1).padStart(2, '0')}\` ${savedLink(t)} · ${fmtTime(t.duration)}`);
  const id = `${list.id}:${userId}`;
  const empty = !list.tracks.length;
  return {
    flags: V2 | MessageFlags.Ephemeral,
    allowedMentions: NO_PINGS,
    components: [
      container([
        text(`### ${tag('ms_playlist')} ${clean(list.name, 32)}\n-# ${list.tracks.length} canciones · ${totalTime(list.tracks)}`),
        sep(),
        text(empty ? 'Esta playlist está vacía. Añade canciones con `/playlist agregar` o con el botón **Guardar en favoritas** del panel.' : lines.join('\n')),
        sep(),
        row(
          button(`pl:play:${id}`, 'Reproducir', 3, empty, 'ms_play'),
          button(`pl:page:${id}:${p - 1}`, '', 2, p === 0, 'ms_back'),
          button(`pl:page:${id}:${p + 1}`, '', 2, p >= pages - 1, 'ms_next')
        ),
        text(`-# Página ${p + 1} de ${pages} · Para quitar una canción: \`/playlist quitar\` con su número`),
      ]),
    ],
  };
}

/** Aviso al poner una playlist en la cola. */
function savedQueuedView(unit, player, list, added, { willStart, skipped }) {
  const t = added[0];
  return {
    flags: V2,
    allowedMentions: NO_PINGS,
    components: [
      container([
        section(
          [
            `### ${tag('ms_playlist')} Playlist en cola`,
            `**${clean(list.name, 32)}**: ${added.length} canciones añadidas en orden aleatorio${willStart ? ', empieza a sonar en unos segundos' : ''}.`,
            skipped > 0 ? `-# ${skipped} no entraron porque la cola está llena.` : null,
            `-# ${clean(unit.name, 30)} en <#${player.voiceChannelId}>`,
          ]
            .filter(Boolean)
            .join('\n'),
          t ? artwork(t) : null
        ),
      ]),
    ],
  };
}

/** Ayuda. */
function helpView() {
  return {
    flags: V2,
    allowedMentions: NO_PINGS,
    components: [
      container([
        text(`### ${tag('ms_music')} Música MFC`),
        text(
          [
            'Entra a un canal de voz y pide una canción. Si el bot principal ya está en otro canal, **llega uno de los bots de apoyo** a tu canal.',
            '',
            '**Reproducir:** `/play` con el nombre o el enlace',
            '**Controles:** botones del panel, o `/skip` · `/stop` · `/pause` · `/queue` · `/nowplaying` · `/volume` · `/loop` · `/shuffle` · `/bots`',
            '**Playlists:** botón **Guardar en favoritas** del panel, o `/playlist` (crear, ver, agregar, guardar, guardar-cola, quitar, renombrar, borrar). Para escucharla: `/playplaylist`',
            '',
            '-# Acepta YouTube, SoundCloud y enlaces de Spotify. Solo controla la música quien está en el mismo canal de voz.',
          ].join('\n')
        ),
      ]),
    ],
  };
}

module.exports = { V2, notice, playlistsOverview, playlistView, savedQueuedView, playerPanel, queueView, addedView, botsView, helpView, fmtTime, clean };
