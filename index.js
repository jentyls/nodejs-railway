const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const unzipper = require("unzipper");
const http = require("http");
const net = require("net");
const crypto = require("crypto"); // 用于计算动态 WS 握手

const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  XRAY_PORT: 3000, 
  RAIL_DOMAIN: process.env.RAILWAY_STATIC_URL || "nodejs-railway-production-ad5e.up.railway.app",
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  FILE_PATH: "./bin_core",
};

if (!fs.existsSync(CONFIG.FILE_PATH)) fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });

async function boot() {
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.2.6/Xray-linux-64.zip`;

  try {
    console.log("[INFO] 🚀 启动原生IP动态握手版...");
    const response = await axios({ url: xrayZipUrl, method: 'GET', responseType: 'stream' });
    await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    
    if (fs.existsSync(xrayPath)) fs.chmodSync(xrayPath, 0o755);
    else {
        const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
        if (bin) { fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath); fs.chmodSync(xrayPath, 0o755); }
    }

    const config = {
      log: { loglevel: "error" },
      inbounds: [{
        port: CONFIG.XRAY_PORT,
        protocol: "vless",
        settings: { clients: [{ id: CONFIG.UUID, level: 0 }], decryption: "none" },
        streamSettings: { network: "ws", wsSettings: { path: "/xray" } }
      }],
      outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });
    console.log(`[✓] Xray Engine Ready.`);
  } catch (err) { console.error(`Boot Failed: ${err.message}`); }
}

app.get("/", (req, res) => res.send("System Active"));
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const vless = `vless://${CONFIG.UUID}@${CONFIG.RAIL_DOMAIN}:443?encryption=none&security=tls&sni=${CONFIG.RAIL_DOMAIN}&type=ws&path=%2Fxray#Railway-Pure-Native`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();

const server = http.createServer(app);

// 【核心修正】处理动态 WebSocket 握手
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/xray' && req.headers['upgrade']?.toLowerCase() === 'websocket') {
    const key = req.headers['sec-websocket-key'];
    // 动态计算 Sec-WebSocket-Accept
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    
    const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.end());
    socket.on('error', () => target.end());
  }
});

server.listen(CONFIG.PORT, "0.0.0.0");
