// Grupo de bots de música: cada cuenta de bot solo puede estar en un canal de voz por servidor,
// así que hay 1 principal + N de apoyo, todos conectados al mismo Lavalink.
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const cfg = require('./config');
const icons = require('./icons');

/** @typedef {{ index:number, name:string, isMain:boolean, client:import('discord.js').Client, manager:LavalinkManager, ready:boolean }} Unit */

/** @type {Unit[]} */
const units = [];

function createUnit(token, index) {
  const isMain = index === 0;
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
  // Todo va por comandos /: no hace falta leer mensajes
  const client = new Client({ intents });
  icons.install(client);

  const manager = new LavalinkManager({
    nodes: [{ ...cfg.LAVALINK, id: `${cfg.LAVALINK.id}-${index}`, retryAmount: Infinity, retryDelay: 5000 }],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: true,
    autoSkipOnResolveError: true,
    client: { id: '0', username: 'mfc-music' },
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      onDisconnect: { autoReconnect: true, destroyPlayer: false },
      onEmptyQueue: { destroyAfterMs: cfg.IDLE_LEAVE_MS },
      useUnresolvedData: true,
      clientBasedPositionUpdateInterval: 1000,
    },
    queueOptions: { maxPreviousTracks: 15 },
  });

  /** @type {Unit} */
  const unit = { index, name: isMain ? 'Bot principal' : `Apoyo ${index}`, isMain, client, manager, ready: false };

  client.on('raw', (d) => manager.sendRawData(d));
  client.once('clientReady', async () => {
    unit.name = client.user.globalName || client.user.username;
    await manager.init({ id: client.user.id, username: client.user.username });
    unit.ready = true;
    // Bloqueo de servidor: solo el servidor oficial
    for (const g of client.guilds.cache.values()) if (g.id !== cfg.GUILD_ID) await g.leave().catch(() => {});
    // Estado: solo el enlace de la web
    client.user.setPresence({
      activities: [{ name: 'https://mafiachinactr.com/', type: ActivityType.Custom, state: 'https://mafiachinactr.com/' }],
      status: 'online',
    });
    console.log(`[MUSIC] ${unit.name} listo (${isMain ? 'principal' : `apoyo ${index}`}).`);
  });
  client.on('guildCreate', (g) => {
    if (g.id !== cfg.GUILD_ID) g.leave().catch(() => {});
  });
  manager.nodeManager.on('error', (node, err) => console.error(`[LAVALINK ${index}]`, err?.message || err));
  manager.nodeManager.on('disconnect', (node, reason) => console.warn(`[LAVALINK ${index}] desconectado`, reason?.reason || ''));

  units.push(unit);
  return { unit, token };
}

/** Bot que ya está en ese canal de voz (o null). */
function unitInChannel(guildId, voiceChannelId) {
  return units.find((u) => u.ready && u.manager.players.get(guildId)?.voiceChannelId === voiceChannelId) || null;
}

/** Primer bot libre que pueda entrar y hablar en ese canal (el principal tiene prioridad). */
function freeUnitFor(guildId, voiceChannelId) {
  for (const u of units) {
    if (!u.ready || u.manager.players.get(guildId)?.voiceChannelId) continue;
    const guild = u.client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(voiceChannelId);
    const me = guild?.members.me;
    if (!channel || !me) continue;
    const perms = channel.permissionsFor(me);
    if (!perms?.has(['ViewChannel', 'Connect', 'Speak'])) continue;
    if (channel.userLimit && channel.members.size >= channel.userLimit && !perms.has('MoveMembers')) continue;
    return u;
  }
  return null;
}

module.exports = { units, createUnit, unitInChannel, freeUnitFor };
