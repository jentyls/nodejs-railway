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
  // 使用更稳健的 v1.8.24 或最新的 v26.2.6 (根据你的需求)
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.2.6/Xray-linux-64.zip`;

  try {
    console.log("[INFO] 🚀 启动 2026 极致纯净原生IP模式...");
    
    // 1. 使用你 package.json 里已有的 unzipper 进行解压
    const response = await axios({ url: xrayZipUrl, method: 'GET', responseType: 'stream' });
    await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
    
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) fs.chmodSync(xrayPath, 0o755);
    else {
        const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
        if (bin) {
            fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath);
            fs.chmodSync(xrayPath, 0o755);
        }
    }

    // 2. 生成配置：gRPC 模式在 Railway 这种公有云上 IP 最纯、连接最稳
    const config = {
      log: { loglevel: "error" },
      inbounds: [{
        port: CONFIG.XRAY_PORT,
        protocol: "vless",
        settings: { clients: [{ id: CONFIG.UUID, level: 0 }], decryption: "none" },
        streamSettings: {
          network: "grpc",
          grpcSettings: { serviceName: "speed-grpc", multiMode: true }
        }
      }],
      outbounds: [{ protocol: "freedom", settings: { domainStrategy: "UseIPv4" } }]
    };
    fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
    
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });
    console.log(`[✓] Xray Engine Active on Port ${CONFIG.XRAY_PORT}`);

  } catch (err) {
    console.error(`[ERROR] Boot Failed: ${err.message}`);
  }
}

// 首页及订阅
app.get("/", (req, res) => res.send(`Pure Native IP Mode - 2026`));
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const vless = `vless://${CONFIG.UUID}@${CONFIG.RAIL_DOMAIN}:443?encryption=none&security=tls&sni=${CONFIG.RAIL_DOMAIN}&type=grpc&serviceName=speed-grpc#Railway-Pure-Native`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();

// 【硬核转发逻辑】处理 443 端口进来的流量，完美转接给 Xray
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    target.write(head);
    socket.pipe(target).pipe(socket);
  });
  target.on('error', () => socket.end());
});

server.listen(CONFIG.PORT, "0.0.0.0");
