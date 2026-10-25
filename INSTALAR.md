# Bot de música MFC: instalación en otra VPS

Incluye todo: los 7 bots (principal + 6 de apoyo), Lavalink (con Java incluido), el servidor de PO tokens,
yt-dlp, deno, las cookies de YouTube, las playlists guardadas y los iconos de los mensajes.

## Requisitos de la VPS nueva
- Linux x86_64 (Ubuntu 22.04 o superior), 2 GB de RAM libres y 3 GB de disco (la caché de audio crece hasta 5 GB).
- Node.js 20 o superior y PM2:  `sudo apt install -y nodejs npm && sudo npm i -g pm2`
  (si `node -v` da menos de 20, instala Node 20+ desde NodeSource)

## Pasos
1. Subir y descomprimir:
   `scp mfc-music-bot.zip usuario@IP_NUEVA:~/` y luego `sudo apt install -y unzip && mkdir -p ~/mfc-music && unzip -q mfc-music-bot.zip -d ~/mfc-music`
2. `cd ~/mfc-music && ./instalar.sh`
3. Comprobar: `pm2 ls` debe mostrar mfc-potoken, mfc-lavalink y mfc-music en línea, y `pm2 logs mfc-music` los 7 bots "listo".
4. Que arranque con la VPS: `pm2 startup` (ejecuta la línea que muestre) y `pm2 save`.

## Importante
- **Nunca dejes los bots encendidos en las dos VPS a la vez**: los mismos tokens se pelean y se desconectan.
- Si la IP nueva está bloqueada por YouTube ("Sign in to confirm you're not a bot"), renueva las cookies:
  exporta solo las de youtube.com (ventana de incognito) y guárdalas en `secrets/youtube-cookies.txt`.
  `secrets/youtube-cookies-reserva.txt` es la sesión de respaldo.
- `.env` y `secrets/` contienen tokens y sesiones: no los subas a ningún sitio público.
- Para la gestión de cookies, avisos por DM al owner y comandos, nada cambia: el código no depende de la ruta.
