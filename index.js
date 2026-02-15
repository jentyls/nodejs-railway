const express = require("express");
const app = express();
const axios = require("axios");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const unzipper = require("unzipper");

// ============================================================================
// I. 核心配置
// ============================================================================
const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  ARGO_DOMAIN: process.env.ARGO_DOMAIN?.trim() || "",
  ARGO_AUTH: process.env.ARGO_AUTH?.trim() || "",
  ARGO_PORT: 8001,
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  FILE_PATH: process.env.FILE_PATH || "./bin_core",
  LOG_LEVEL: "warning",
};

const logger = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`),
};

if (!fs.existsSync(CONFIG.FILE_PATH)) fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });

// ============================================================================
// II. 核心启动流程
// ============================================================================
async function boot() {
  // 1. Argo 官方链接
  const argoUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  
  // 2. Xray 官方链接 (2026 最新版本 v26.2.6)
  const xrayVersion = "v26.2.6"; 
  const xrayZipUrl = `https://github.com/XTLS/Xray-core/releases/download/${xrayVersion}/Xray-linux-64.zip`;

  try {
    logger.info(`🚀 Booting System (Time: 2026-02-15)...`);

    // --- 下载 Argo ---
    const argoPath = path.join(CONFIG.FILE_PATH, 'cloudflared');
    logger.info("Downloading Cloudflared...");
    await downloadFile(argoUrl, argoPath);
    fs.chmodSync(argoPath, 0o755);

    // --- 下载并解压 Xray ---
    logger.info(`Downloading Xray ${xrayVersion}...`);
    await downloadAndUnzip(xrayZipUrl, CONFIG.FILE_PATH);
    
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) {
        fs.chmodSync(xrayPath, 0o755);
        logger.success("Xray installed.");
    } else {
        // 自动兼容解压后的各种命名格式
        const files = fs.readdirSync(CONFIG.FILE_PATH);
        const bin = files.find(f => f.toLowerCase() === 'xray' || f.startsWith('xray-linux'));
        if (bin) {
            fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath);
            fs.chmodSync(xrayPath, 0o755);
            logger.success("Xray renamed and ready.");
        } else {
            throw new Error("Xray binary missing!");
        }
    }

    generateXrayConfig();
    
    logger.info("Starting Xray...");
    spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });

    await new Promise(r => setTimeout(r, 2000));
    
    logger.info("Starting Argo...");
    startArgo(argoPath);

  } catch (err) {
    logger.error(`Boot Failed: ${err.message}`);
    process.exit(1);
  }
}

// 通用下载函数
async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// 通用解压函数
async function downloadAndUnzip(url, dest) {
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 30000 });
  return response.data.pipe(unzipper.Extract({ path: dest })).promise();
}

function generateXrayConfig() {
  const config = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        port: CONFIG.ARGO_PORT, protocol: "vless",
        settings: { clients: [{ id: CONFIG.UUID, flow: "xtls-rprx-vision", level: 0 }], decryption: "none", fallbacks: [{ alpn: "http/1.1", dest: 3001 }, { alpn: "h2", path: "/grpc", dest: 3002 }] },
        streamSettings: { network: "tcp", security: "none" }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] }
      },
      { port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: CONFIG.UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: CONFIG.UUID }], decryption: "none" }, streamSettings: { network: "grpc", grpcSettings: { serviceName: "grpc", multiMode: true }, security: "none" } }
    ],
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
  };
  fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
}

function startArgo(binPath) {
  const args = ["tunnel", "--edge-ip-version", "auto", "--no-autoupdate", "--protocol", "http2", "--url", `http://localhost:${CONFIG.ARGO_PORT}`];
  if (CONFIG.ARGO_AUTH && !CONFIG.ARGO_AUTH.includes("{")) {
    args.splice(6, 2);
    args.push("run", "--token", CONFIG.ARGO_AUTH);
  }
  
  const argo = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  
  const handleLog = (data) => {
    const log = data.toString();
    console.log(log); 
    if (log.includes("trycloudflare.com")) {
      const match = log.match(/https:\/\/([\w\-]+\.trycloudflare\.com)/);
      if (match) { 
        CONFIG.ARGO_DOMAIN = match[1]; 
        logger.success(`Argo Domain Captured: ${match[1]}`);
      }
    }
  };
  argo.stdout.on("data", handleLog);
  argo.stderr.on("data", handleLog);
}

// ============================================================================
// III. 订阅与 Web 接口
// ============================================================================
app.get("/", (req, res) => res.send(`System Online - 2026 Version. Domain: ${CONFIG.ARGO_DOMAIN || 'Waiting...'}`));

app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const domain = CONFIG.ARGO_DOMAIN || "pending.wait.for.argo";
  const vless = `vless://${CONFIG.UUID}@${domain}:443?encryption=none&flow=xtls-rprx-vision&security=tls&sni=${domain}&type=tcp&fp=chrome#Railway-2026`;
  res.send(Buffer.from(vless).toString("base64"));
});

boot();
app.listen(CONFIG.PORT, "::", () => logger.success(`Server listening on port ${CONFIG.PORT}`));
