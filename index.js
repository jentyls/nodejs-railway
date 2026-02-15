const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const unzipper = require("unzipper");

const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  // 关键：这里直接读取 Railway 自动分配的域名
  RAIL_DOMAIN: process.env.RAILWAY_STATIC_URL || "nodejs-railway-production-a3e6.up.railway.app",
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  FILE_PATH: "./bin_core",
};

const logger = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`),
};

if (!fs.existsSync(CONFIG.FILE_PATH)) fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });

async function boot() {
  // 只下载 Xray，不再使用 Cloudflared
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/v26.2.6/Xray-linux-64.zip`;

  try {
    logger.info("🚀 启动原生 IP 纯净模式 (无CF转接)...");
    
    // 下载 Xray
    const response = await axios({ url: xrayZipUrl, method: 'GET', responseType: 'stream' });
    await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
    
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) fs.chmodSync(xrayPath, 0o755);
    else {
        const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
        fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath);
        fs.chmodSync(xrayPath, 0o755);
    }

    // 生成直接映射端口的配置
    generateDirectConfig();
    
    logger.info("Launching Xray Core...");
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });

  } catch (err) {
    logger.error(`Boot Failed: ${err.message}`);
    process.exit(1);
  }
}

function generateDirectConfig() {
  const config = {
    log: { loglevel: "warning" },
    inbounds: [{
      port: CONFIG.PORT, // 直接监听 Railway 分配的外部端口
      protocol: "vless",
      settings: { clients: [{ id: CONFIG.UUID, level: 0 }], decryption: "none" },
      streamSettings: {
        network: "ws", // 只有 WS 模式才能通过 Railway 的反代
        wsSettings: { path: "/speed" }
      }
    }],
    outbounds: [{ protocol: "freedom" }]
  };
  fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
}

// 首页显示
app.get("/", (req, res) => res.send(`System Running on Native IP: ${CONFIG.RAIL_DOMAIN}`));

// 订阅内容
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const domain = CONFIG.RAIL_DOMAIN;
  // 注意：这是直连 Railway 的节点，不经过 Cloudflare
  const vless = `vless://${CONFIG.UUID}@${domain}:443?encryption=none&security=tls&sni=${domain}&type=ws&path=%2Fspeed#Railway-Native-IP`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();
app.listen(CONFIG.PORT);
