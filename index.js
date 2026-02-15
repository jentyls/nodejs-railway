const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const unzipper = require("unzipper");
const http = require("http");
const net = require("net");

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
  // 【核心降级】回退到 v1.8.4，这是公认最稳、不报错、兼容性最好的版本
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip`;
  
  try {
    console.log("[INFO] 🚀 启动经典稳定版 v1.8.4 (全头转发)...");
    
    // 下载与解压
    const response = await axios({ url: xrayZipUrl, method: 'GET', responseType: 'stream' });
    await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
    
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) fs.chmodSync(xrayPath, 0o755);
    else {
        const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
        if (bin) { fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath); fs.chmodSync(xrayPath, 0o755); }
    }

    // 【配置】经典 VLESS + WebSocket
    const config = {
      log: { loglevel: "error" },
      inbounds: [{
        port: CONFIG.XRAY_PORT,
        protocol: "vless",
        settings: { 
          clients: [{ id: CONFIG.UUID, level: 0 }], 
          decryption: "none" 
        },
        streamSettings: {
          network: "ws",
          wsSettings: { path: "/xray" }
        }
      }],
      outbounds: [{ protocol: "freedom" }]
    };
    
    fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });
    console.log(`[✓] Xray v1.8.4 核心已启动`);

  } catch (err) { console.error(`Boot Failed: ${err.message}`); }
}

app.get("/", (req, res) => res.send("Classic Stable Mode"));

// 订阅链接
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const vless = `vless://${CONFIG.UUID}@${CONFIG.RAIL_DOMAIN}:443?encryption=none&security=tls&sni=${CONFIG.RAIL_DOMAIN}&type=ws&path=%2Fxray#Railway-Classic-Stable`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();

const server = http.createServer(app);

// 【核心修复：完美转发逻辑】
server.on('upgrade', (req, socket, head) => {
    if (req.url === '/xray') {
        const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
            // 1. 构造请求头：把客户端发来的所有头（包括 User-Agent, Version 等）全部拿过来
            let headerStr = `${req.method} ${req.url} HTTP/1.1\r\n`;
            for (let k in req.headers) {
                headerStr += `${k}: ${req.headers[k]}\r\n`;
            }
            headerStr += '\r\n'; // 结束符

            // 2. 发送给 Xray
            target.write(headerStr);
            target.write(head);
            
            // 3. 建立管道，让数据互通
            socket.pipe(target);
            target.pipe(socket);
        });

        target.on('error', (err) => {
            socket.end();
        });
    } else {
        socket.end();
    }
});

server.listen(CONFIG.PORT);
