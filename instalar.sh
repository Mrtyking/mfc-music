#!/usr/bin/env bash
# Deja el bot de música listo en esta máquina (después de descomprimir el paquete).
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Falta Node.js (20+)"; exit 1; }
command -v pm2 >/dev/null || { echo "Falta PM2: sudo npm i -g pm2"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node 20 o superior"; exit 1; }
chmod +x bin/yt-dlp bin/deno runtime/bin/* runtime-node/bin/* 2>/dev/null || true
chmod 600 .env secrets/* 2>/dev/null || true
mkdir -p cache/audio data
[ -d node_modules ] || npm install --omit=dev
pm2 start ecosystem.config.js
pm2 save
sleep 12
pm2 ls
echo "Revisa: pm2 logs mfc-music --lines 20  (deben salir los 7 bots 'listo')"
