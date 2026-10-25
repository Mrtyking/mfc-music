// Bot de música de MAFIA CHINA CTR.
// El bot principal recibe los comandos; si ya está ocupado en otro canal, entra uno de los bots de apoyo.
const { MessageFlags, ApplicationCommandOptionType } = require('discord.js');
const cfg = require('./config');
const ui = require('./ui');
const { units, createUnit } = require('./pool');
const music = require('./music');
const pl = require('./playlists');
const { startResolverServer, setCookiesExpiredHandler } = require('./youtube');

startResolverServer();

// Si YouTube deja de aceptar las cookies, se avisa por privado al dueño del servidor de la web
const COOKIES_ALERT_USER = '262514432427556865';
setCookiesExpiredHandler(async ({ backupLeft }) => {
  const user = await units[0]?.client.users.fetch(COOKIES_ALERT_USER).catch(() => null);
  const howTo =
    'Hay que sacar cookies nuevas en una ventana de incógnito (iniciar sesión, ir a youtube.com/robots.txt, exportarlas y cerrar la ventana) y dejarlas en Descargas como cookies.txt.';
  await user?.send(
    backupLeft
      ? ui.notice('Cookies de YouTube: usando la reserva', `YouTube ya no acepta las cookies principales. La música sigue funcionando con las de reserva, pero conviene renovarlas antes de que caduquen también.\n\n${howTo}`, 0xf59e0b)
      : ui.notice('La música dejó de funcionar', `YouTube ya no acepta las cookies de la cuenta secundaria (ni las de reserva), así que las canciones no suenan.\n\n${howTo}`, 0xf59e0b)
  );
});

const { Subcommand: SUB, String: STR, Integer: INT } = ApplicationCommandOptionType;
const listOpt = (required) => ({ type: STR, name: 'nombre', description: 'Nombre de la playlist', required, autocomplete: true });

const SLASH = [
  { name: 'play', description: 'Reproduce una canción o lista (nombre, YouTube, SoundCloud o Spotify)', options: [{ type: ApplicationCommandOptionType.String, name: 'cancion', description: 'Nombre o enlace', required: true }] },
  { name: 'skip', description: 'Salta la canción actual' },
  { name: 'stop', description: 'Para la música y saca al bot del canal' },
  { name: 'pause', description: 'Pausa o reanuda la música' },
  { name: 'queue', description: 'Muestra la cola de tu canal' },
  { name: 'nowplaying', description: 'Muestra la canción que suena en tu canal' },
  { name: 'volume', description: 'Cambia el volumen (0-150)', options: [{ type: ApplicationCommandOptionType.Integer, name: 'nivel', description: '0 a 150', required: true, min_value: 0, max_value: 150 }] },
  { name: 'loop', description: 'Repetir: no → canción → cola' },
  { name: 'shuffle', description: 'Mezcla la cola' },
  { name: 'bots', description: 'Qué bots de música están libres u ocupados' },
  { name: 'musica', description: 'Cómo usar el bot de música' },
  { name: 'playplaylist', description: 'Pone toda una de tus playlists en la cola, mezclada', options: [listOpt(true)] },
  {
    name: 'playlist',
    description: 'Tus playlists de canciones favoritas',
    options: [
      { type: SUB, name: 'ver', description: 'Tus playlists, o las canciones de una', options: [listOpt(false)] },
      { type: SUB, name: 'crear', description: 'Crea una playlist nueva', options: [{ type: STR, name: 'nombre', description: 'Nombre de la playlist', required: true, max_length: 32 }] },
      { type: SUB, name: 'agregar', description: 'Añade una canción a una playlist', options: [listOpt(true), { type: STR, name: 'cancion', description: 'Nombre o enlace de la canción', required: true }] },
      { type: SUB, name: 'guardar', description: 'Guarda la canción que suena ahora (por defecto en Favoritas)', options: [listOpt(false)] },
      { type: SUB, name: 'guardar-cola', description: 'Guarda toda la cola de tu canal en una playlist (si no existe, se crea)', options: [{ ...listOpt(true), max_length: 32 }] },
      { type: SUB, name: 'quitar', description: 'Quita una canción de una playlist', options: [listOpt(true), { type: INT, name: 'posicion', description: 'Número de la canción (se ve en /playlist ver)', required: true, min_value: 1 }] },
      { type: SUB, name: 'renombrar', description: 'Cambia el nombre de una playlist', options: [listOpt(true), { type: STR, name: 'nuevo', description: 'Nombre nuevo', required: true, max_length: 32 }] },
      { type: SUB, name: 'borrar', description: 'Borra una playlist entera', options: [listOpt(true)] },
    ],
  },
];


// ── Playlists ────────────────────────────────────────────────────────────────
/** Para editar un mensaje: solo la marca de Components V2 (lo privado no se puede cambiar al editar). */
const asEdit = (payload) => ({ ...payload, flags: ui.V2 });
const plNotice = (title, body, warn = false) => ({ ...ui.notice(title, body, warn ? 0xf59e0b : undefined), flags: ui.V2 | MessageFlags.Ephemeral });

/** Guarda canciones en una playlist del usuario y devuelve el aviso. */
function saveTracks(userId, name, tracks) {
  const valid = tracks.filter(Boolean);
  if (!valid.length) return plNotice('Nada que guardar', 'No hay ninguna canción sonando en tu canal ahora mismo.', true);
  const { list, error } = pl.findOrFavorites(userId, name);
  if (error) return plNotice('No se pudo guardar', error, true);
  const { added, duplicates, full } = pl.addTracks(list, valid);
  if (!added) {
    if (full) return plNotice('Playlist llena', `**${ui.clean(list.name, 32)}** ya tiene ${pl.MAX_TRACKS} canciones (el máximo).`, true);
    return plNotice('Ya estaba guardada', `${valid.length > 1 ? 'Esas canciones ya estaban' : 'Esa canción ya estaba'} en **${ui.clean(list.name, 32)}**.`);
  }
  const extra = [duplicates ? `${duplicates} ya estaban` : null, full ? `${full} no cupieron (máximo ${pl.MAX_TRACKS})` : null].filter(Boolean).join(' · ');
  const what = valid.length === 1 ? `**${ui.clean(valid[0].title, 70)}**` : `${added} canciones`;
  return plNotice('Guardada', `${what} en **${ui.clean(list.name, 32)}** (${list.tracks.length} en total).${extra ? `\n-# ${extra}` : ''}`);
}

async function handlePlaylist(it) {
  const sub = it.commandName === 'playplaylist' ? 'reproducir' : it.options.getSubcommand();
  const userId = it.user.id;
  const name = it.options.getString('nombre');
  const needList = () => {
    const list = pl.find(userId, name);
    if (!list) it.reply(plNotice('No existe', `No tienes ninguna playlist llamada **${ui.clean(name, 32)}**. Mira las tuyas con \`/playlist ver\`.`, true));
    return list;
  };

  if (sub === 'ver') {
    if (!name) return it.reply(ui.playlistsOverview(pl.listsOf(userId), { max: pl.MAX_LISTS }));
    const list = needList();
    if (list) return it.reply(ui.playlistView(list, userId));
    return;
  }
  if (sub === 'crear') {
    const { list, error } = pl.create(userId, it.options.getString('nombre'));
    if (error) return it.reply(plNotice('No se pudo crear', error, true));
    return it.reply(plNotice('Playlist creada', `**${ui.clean(list.name, 32)}** está lista. Añade canciones con \`/playlist agregar\` o con **Guardar en favoritas** del panel.`));
  }
  if (sub === 'guardar') {
    const t = music.currentTrackFor(it.guildId, userId);
    return it.reply(saveTracks(userId, name, t ? [music.toSaved(t)] : []));
  }
  if (sub === 'guardar-cola') {
    const queue = music.queueFor(it.guildId, userId);
    if (!queue.length) return it.reply(plNotice('Nada que guardar', 'No hay música en tu canal de voz ahora mismo.', true));
    if (!pl.find(userId, name)) {
      const { error } = pl.create(userId, name);
      if (error) return it.reply(plNotice('No se pudo guardar', error, true));
    }
    return it.reply(saveTracks(userId, name, queue.map(music.toSaved)));
  }
  if (sub === 'agregar') {
    const list = needList();
    if (!list) return;
    await it.deferReply({ flags: MessageFlags.Ephemeral });
    const found = await music.searchOne(it.options.getString('cancion'));
    if (!found) return it.editReply(asEdit(plNotice('Sin resultados', 'No encontré esa canción. Prueba con otro nombre o con el enlace de YouTube.', true)));
    return it.editReply(asEdit(saveTracks(userId, list.name, [found])));
  }
  if (sub === 'quitar') {
    const list = needList();
    if (!list) return;
    const removed = pl.removeTrack(list, it.options.getInteger('posicion'));
    if (!removed) return it.reply(plNotice('Número no válido', `**${ui.clean(list.name, 32)}** tiene ${list.tracks.length} canciones. Mira los números con \`/playlist ver\`.`, true));
    return it.reply(plNotice('Quitada', `**${ui.clean(removed.title, 70)}** ya no está en **${ui.clean(list.name, 32)}**.`));
  }
  if (sub === 'renombrar') {
    const list = needList();
    if (!list) return;
    const old = list.name;
    const { error } = pl.rename(userId, list, it.options.getString('nuevo'));
    if (error) return it.reply(plNotice('No se pudo renombrar', error, true));
    return it.reply(plNotice('Renombrada', `**${ui.clean(old, 32)}** ahora se llama **${ui.clean(list.name, 32)}**.`));
  }
  if (sub === 'borrar') {
    const list = needList();
    if (!list) return;
    pl.removeList(userId, list);
    return it.reply(plNotice('Playlist borrada', `**${ui.clean(list.name, 32)}** y sus ${list.tracks.length} canciones se borraron.`));
  }
  if (sub === 'reproducir') {
    const list = needList();
    if (!list) return;
    await it.deferReply();
    return it.editReply(await music.playSaved({ guildId: it.guildId, userId, textChannelId: it.channelId, list }));
  }
}

/** Botones de la vista de una playlist: pl:<accion>:<listId>:<userId>[:pagina] */
async function handlePlaylistButton(it) {
  const [, action, listId, ownerId, page] = it.customId.split(':');
  if (it.user.id !== ownerId) return it.reply(plNotice('No es tuya', 'Solo quien abrió esta playlist puede usar estos botones.', true));
  const list = pl.find(ownerId, listId);
  if (!list) return it.reply(plNotice('Ya no existe', 'Esa playlist se borró.', true));
  if (action === 'page') return it.update(asEdit(ui.playlistView(list, ownerId, Number(page) || 0)));
  if (action === 'play') {
    await it.deferReply();
    return it.editReply(await music.playSaved({ guildId: it.guildId, userId: ownerId, textChannelId: it.channelId, list }));
  }
}

async function start() {
  createUnit(cfg.MAIN_TOKEN, 0);
  cfg.SUB_TOKENS.forEach((t, i) => createUnit(t, i + 1));
  const mainUnit = units[0];
  const mainClient = mainUnit.client;

  for (const u of units) music.wireEvents(u);

  // Comandos solo en el servidor oficial (aparecen al instante). Si el bot aún no está, se registran al entrar.
  const registerCommands = () =>
    mainClient.application.commands
      .set(SLASH, cfg.GUILD_ID)
      .then(() => console.log('[MUSIC] Comandos /play registrados.'))
      .catch((e) => console.warn('[MUSIC] Comandos pendientes (¿el bot está en el servidor?):', e?.message));
  mainClient.once('clientReady', registerCommands);
  mainClient.on('guildCreate', (g) => g.id === cfg.GUILD_ID && registerCommands());

  // Si alguien se va y el bot queda solo, se va al minuto
  mainClient.on('voiceStateUpdate', (oldS, newS) => {
    const g = newS.guild?.id || oldS.guild?.id;
    if (g === cfg.GUILD_ID) music.checkEmptyChannels(g);
  });

  // ── Slash y botones ──
  mainClient.on('interactionCreate', async (it) => {
    if (it.guildId !== cfg.GUILD_ID) return;
    try {
      if (it.isAutocomplete()) {
        const typed = String(it.options.getFocused() || '').toLowerCase();
        const choices = pl
          .listsOf(it.user.id)
          .filter((l) => l.name.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((l) => ({ name: `${l.name} (${l.tracks.length})`, value: l.name }));
        return it.respond(choices).catch(() => {});
      }
      if (it.isChatInputCommand() && (it.commandName === 'playlist' || it.commandName === 'playplaylist')) return handlePlaylist(it);
      if (it.isButton() && it.customId.startsWith('pl:')) return handlePlaylistButton(it);
      if (it.isButton() && it.customId.startsWith('mus:save:')) {
        const t = music.currentTrackFor(it.guildId, it.user.id, Number(it.customId.split(':')[2]));
        return it.reply({ ...saveTracks(it.user.id, pl.FAVORITES, t ? [music.toSaved(t)] : []), flags: ui.V2 | MessageFlags.Ephemeral });
      }
      if (it.isChatInputCommand()) {
        const name = it.commandName;
        if (name === 'musica') return it.reply({ ...ui.helpView(), flags: ui.V2 | MessageFlags.Ephemeral });
        if (name === 'bots') return it.reply({ ...ui.botsView(units, it.guildId), flags: ui.V2 | MessageFlags.Ephemeral });
        if (name === 'play') {
          await it.deferReply();
          const payload = await music.play({ guildId: it.guildId, userId: it.user.id, query: it.options.getString('cancion'), textChannelId: it.channelId });
          return it.editReply(payload);
        }
        const action = { nowplaying: 'np' }[name] || name;
        const r = await music.control(action, { guildId: it.guildId, userId: it.user.id, value: it.options.getInteger?.('nivel') });
        if (r.refresh && r.player) music.sendOrEditPanel(r.unit, r.player);
        return it.reply({ ...r.reply, flags: (r.reply.flags || ui.V2) | (action === 'np' ? 0 : MessageFlags.Ephemeral) });
      }
      if (it.isButton() && it.customId.startsWith('mus:')) {
        const [, action, idx] = it.customId.split(':');
        const r = await music.control(action, { guildId: it.guildId, userId: it.user.id, unitIndex: Number(idx) });
        // Los botones actualizan el panel en el sitio; los avisos solo los ve quien pulsa
        if (r.refresh && r.player && it.message) {
          await it.update(ui.playerPanel(r.player, r.unit)).catch(() => {});
          return;
        }
        return it.reply({ ...r.reply, flags: (r.reply.flags || ui.V2) | MessageFlags.Ephemeral });
      }
    } catch (e) {
      console.error('[MUSIC INTERACTION]', e);
      const err = ui.notice('Algo falló', 'No se pudo completar. Inténtalo otra vez en unos segundos.', 0xf59e0b);
      if (it.deferred || it.replied) it.editReply(err).catch(() => {});
      else it.reply({ ...err, flags: ui.V2 | MessageFlags.Ephemeral }).catch(() => {});
    }
  });

  // Conexión escalonada para no saturar el login de Discord
  for (const u of units) {
    await u.client.login(u.index === 0 ? cfg.MAIN_TOKEN : cfg.SUB_TOKENS[u.index - 1]);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

process.on('unhandledRejection', (e) => console.error('[MUSIC] Promesa sin manejar:', e?.message || e));
process.on('uncaughtException', (e) => console.error('[MUSIC] Excepción:', e?.message || e));

start().catch((e) => {
  console.error('[MUSIC] No se pudo arrancar:', e);
  process.exit(1);
});
