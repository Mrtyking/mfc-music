// PM2: motor de audio (Lavalink) + servidor de PO tokens para yt-dlp + los 7 bots de música (un solo proceso Node)
module.exports = {
  apps: [
    {
      name: 'mfc-potoken',
      cwd: __dirname + '/pot-server/server',
      script: __dirname + '/runtime-node/bin/node',
      args: 'build/main.js --port 4416',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      name: 'mfc-lavalink',
      cwd: __dirname + '/lavalink',
      script: __dirname + '/runtime/bin/java',
      args: '-Xms256m -Xmx640m -XX:+UseG1GC -jar Lavalink.jar',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
    {
      name: 'mfc-music',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: '--max-old-space-size=384',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
    },
  ],
};
