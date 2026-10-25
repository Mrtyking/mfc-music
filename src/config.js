// Configuración del bot de música. Los tokens se leen de .env (archivo privado, permisos 600).
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  if (!line || line.startsWith('#') || !line.includes('=')) continue;
  const i = line.indexOf('=');
  env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

module.exports = {
  MAIN_TOKEN: env.MAIN_TOKEN,
  SUB_TOKENS: (env.SUB_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean),
  GUILD_ID: env.GUILD_ID,
  LAVALINK: { host: '127.0.0.1', port: 2333, authorization: env.LAVALINK_PASSWORD, id: 'mfc-local' },

  COLOR: 0xff1a3c,
  DEFAULT_VOLUME: 70,
  MAX_QUEUE: 150, // canciones en cola por bot
  MAX_PER_USER: 25, // canciones en cola por persona
  MAX_PLAYLIST: 50, // canciones que se añaden de una lista
  IDLE_LEAVE_MS: 3 * 60 * 1000, // se va si termina la cola y nadie pide nada
  EMPTY_LEAVE_MS: 60 * 1000, // se va si se queda solo en el canal
};
