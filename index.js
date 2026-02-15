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
  // 1. Argo 官方链接 (Cloudflare 官方源，始终最新)
  const argoUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  
  // 2. Xray 官方链接 (适配 2026年最新 v26.2.6 版本)
  // 关键修正：官方文件名为 Xray-linux-64.zip，而不是 Xray-linux-amd64.zip
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
    logger.info(`Downloading Xray ${xrayVersion} (Official)...`);
    // 这里会自动处理 ZIP 解压
    await downloadAndUnzip(xrayZipUrl, CONFIG.FILE_PATH);
    
    // 检查解压后的文件
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    if (fs.existsSync(xrayPath)) {
        fs.chmodSync(xrayPath, 0o755);
        logger.success("Xray installed successfully.");
    } else {
        // 容错：有时候解压出来可能带后缀，遍历目录找一下
        const files = fs.readdirSync(CONFIG.FILE_PATH);
        const bin = files.find(f => f.toLowerCase() === 'xray' || f.startsWith('xray-linux'));
        if (bin) {
            const realPath = path.join(CONFIG.FILE_PATH, bin);
            fs.renameSync(realPath, xrayPath);
            fs.chmodSync(xrayPath, 0o755);
            logger.success(`Xray found and renamed: ${bin}`);
        } else {
            throw new Error("Xray binary not found after unzip! Check version compatibility.");
        }
    }

    // --- 启动 ---
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

// 通用下载函数 (Axios Stream)
async function downloadFile(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 20000 });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// 通用解压函数 (Unzipper)
async function downloadAndUnzip(url, dest) {
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 20000 });
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
  if (CONFIG.ARGO_AUTH && !CONFIG.ARGO_AUTH.includes("{")) { args.splice(6, 2); args.push("run", "--token", CONFIG.ARGO_AUTH); }
  
  const argo = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  
  // 监听双通道日志，确保抓到域名
  const handleLog = (data) => {
    const log = data.toString();
    console.log(log); 
    if (log.includes("trycloudflare.com")) {
      const match = log.match(/https:\/\/([\w\-]+\.trycloudflare\.com)/);
      if (match) { CONFIG.ARGO_DOMAIN = match[1]; logger.success(`Argo Domain: ${match[1]}`); }
    }
  };
  argo.stdout.on("data", handleLog);
  argo.stderr.on("data", handleLog);
}

app.get("/", (req, res) => res.send("System Online - 2026"));
app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const domain = CONFIG.ARGO_DOMAIN || "pending";
  res.send(Buffer.from(`vless://${CONFIG.UUID}@${domain}:443?encryption=none&flow=xtls-rprx-vision&security=tls&sni=${domain}&type=tcp&fp=chrome#Railway-2026`).toString("base64"));
});

boot();
app.listen(CONFIG.PORT, "::", () => logger.success(`Server on port ${CONFIG.PORT}`));
