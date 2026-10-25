// Enlaces de Spotify: Spotify no deja reproducir su audio, así que se lee el nombre y el artista
// de la página pública del tema y se busca en YouTube.
const SPOTIFY_RE = /^https?:\/\/(open\.)?spotify\.com\/(intl-[a-z]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i;

const isSpotify = (q) => SPOTIFY_RE.test(q);

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** Devuelve una búsqueda "artista - canción" para un enlace de canción de Spotify (o null). */
async function spotifyToQuery(url) {
  const m = url.match(SPOTIFY_RE);
  if (!m || m[3].toLowerCase() !== 'track') return null;
  try {
    const res = await fetch(`https://open.spotify.com/track/${m[4]}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MFCMusic/1.0)', 'Accept-Language': 'es,en;q=0.8' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = decode(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]);
    // og:description: "Artista · Canción · Song · 2023"
    const desc = decode(html.match(/<meta property="og:description" content="([^"]+)"/)?.[1]);
    const artist = desc.split('·')[0]?.trim();
    if (!title) return null;
    return artist ? `${artist} - ${title}` : title;
  } catch {
    return null;
  }
}

module.exports = { isSpotify, spotifyToQuery, SPOTIFY_RE };
