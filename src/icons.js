// Iconos del bot de música (emojis de aplicación). Cada bot de música es una aplicación distinta
// y solo puede usar sus propios emojis, así que los ids se rellenan al enviar: los mensajes llevan
// el marcador @@nombre@@ y cada cliente lo cambia por el id de su aplicación.
const IDS = require('./icon-ids.json');

/** <:nombre:id> para títulos y textos */
const tag = (name) => `<:${name}:@@${name}@@>`;
/** Objeto emoji para botones */
const em = (name) => ({ name, id: `@@${name}@@` });

const MARK = /@@([a-z0-9_]+)@@/g;

/** Hace que todo lo que envíe este cliente a Discord lleve los ids de sus propios emojis. */
function install(client) {
  const rest = client.rest;
  const orig = rest.request.bind(rest);
  rest.request = (opts) => {
    const mine = IDS[client.user?.id] || {};
    if (opts?.body && typeof opts.body === 'object' && !Buffer.isBuffer(opts.body)) {
      const raw = JSON.stringify(opts.body);
      if (raw.includes('@@')) opts = { ...opts, body: JSON.parse(raw.replace(MARK, (m, n) => mine[n] || '0')) };
    }
    return orig(opts);
  };
}

module.exports = { tag, em, install };
