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
  ARGO_DOMAIN: process.env.ARGO_DOMAIN?.trim() || "",
  ARGO_AUTH: process.env.ARGO_AUTH?.trim() || "",
  ARGO_PORT: 8001,
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  FILE_PATH: process.env.FILE_PATH || "./bin_core",
};

const logger = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`),
};

if (!fs.existsSync(CONFIG.FILE_PATH)) fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });

async function boot() {
  const argoUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  const xrayVersion = "v26.2.6"; 
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/${xrayVersion}/Xray-linux-64.zip`;

  try {
    logger.info("🚀 Final Tuning for 2026...");
    const argoPath = path.join(CONFIG.FILE_PATH, 'cloudflared');
    await downloadFile(argoUrl, argoPath);
    fs.chmodSync(argoPath, 0o755);

    await downloadAndUnzip(xrayZipUrl, CONFIG.FILE_PATH);
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) fs.chmodSync(xrayPath, 0o755);
    else {
        const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
        fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath);
        fs.chmodSync(xrayPath, 0o755);
    }

    generateXrayConfig();
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });
    await new Promise(r => setTimeout(r, 2000));
    startArgo(argoPath);
  } catch (err) {
    logger.error(`Boot Failed: ${err.message}`);
    process.exit(1);
  }
}

async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
}

async function downloadAndUnzip(url, dest) {
  const response = await axios({ url, method: 'GET', responseType: 'stream' });
  return response.data.pipe(unzipper.Extract({ path: dest })).promise();
}

function generateXrayConfig() {
  const config = {
    log: { loglevel: "warning" },
    inbounds: [{
      port: CONFIG.ARGO_PORT, protocol: "vless",
      settings: { clients: [{ id: CONFIG.UUID, level: 0 }], decryption: "none" },
      streamSettings: { network: "ws", wsSettings: { path: "/argo" } } // 改用 WS 模式，Argo 隧道最稳
    }],
    outbounds: [{ protocol: "freedom" }]
  };
  fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
}

function startArgo(binPath) {
  const args = ["tunnel", "--edge-ip-version", "auto", "--no-autoupdate", "--protocol", "http2", "--url", `http://localhost:${CONFIG.ARGO_PORT}`];
  const argo = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const handleLog = (data) => {
    const log = data.toString();
    console.log(log);
    if (log.includes("trycloudflare.com")) {
      const match = log.match(/https:\/\/([\w\-]+\.trycloudflare\.com)/);
      if (match) { CONFIG.ARGO_DOMAIN = match[1]; logger.success(`Argo: ${match[1]}`); }
    }
  };
  argo.stdout.on("data", handleLog);
  argo.stderr.on("data", handleLog);
}

app.get("/", (req, res) => res.send(`Active: ${CONFIG.ARGO_DOMAIN}`));
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const domain = CONFIG.ARGO_DOMAIN || "pending";
  // 修正后的通用 VLESS-WS 格式，100% 连上
  const vless = `vless://${CONFIG.UUID}@${domain}:443?encryption=none&security=tls&sni=${domain}&type=ws&path=%2Fargo#Railway-Final`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();
app.listen(CONFIG.PORT, "::");
