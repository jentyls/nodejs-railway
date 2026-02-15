const express = require("express");
const app = express();
const axios = require("axios");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

// ============================================================================
// I. 核心配置
// ============================================================================

const CONFIG = {
  // 身份认证
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,

  // Argo 隧道配置
  ARGO_DOMAIN: process.env.ARGO_DOMAIN?.trim() || "",
  ARGO_AUTH: process.env.ARGO_AUTH?.trim() || "",
  ARGO_PORT: 8001,

  // 路径与订阅
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  NAME: process.env.NAME || "Railway-Xray",
  FILE_PATH: process.env.FILE_PATH || "./bin_core",

  // 性能参数
  LOG_LEVEL: process.env.LOG_LEVEL || "warning",
  ENABLE_STATS: process.env.ENABLE_STATS !== "false",
  RESTART_DELAY: 5000,
};

// ============================================================================
// II. 日志系统
// ============================================================================

const logger = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  error: (msg) => console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[✓]\x1b[0m ${msg}`),
  warn: (msg) => console.warn(`\x1b[33m[WARN]\x1b[0m ${msg}`),
};

// ============================================================================
// III. 系统工具集
// ============================================================================

if (!fs.existsSync(CONFIG.FILE_PATH)) {
  fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });
}

function getArch() {
  const arch = os.arch();
  return { x64: "amd64", x32: "386", arm64: "arm64", aarch64: "arm64" }[arch] || "amd64";
}

// ============================================================================
// IV. Xray 配置生成
// ============================================================================

function generateXrayConfig() {
  const config = {
    log: { loglevel: CONFIG.LOG_LEVEL, access: "" },
    inbounds: [
      {
        port: CONFIG.ARGO_PORT,
        protocol: "vless",
        settings: {
          clients: [{ id: CONFIG.UUID, flow: "xtls-rprx-vision", level: 0 }],
          decryption: "none",
          fallbacks: [
            { alpn: "http/1.1", dest: 3001 },
            { alpn: "h2", path: "/grpc", dest: 3002 }
          ]
        },
        streamSettings: { network: "tcp", tcpSettings: { header: { type: "none" } }, security: "none" },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"] }
      },
      {
        port: 3001, listen: "127.0.0.1", protocol: "vless",
        settings: { clients: [{ id: CONFIG.UUID }], decryption: "none" },
        streamSettings: { network: "tcp", security: "none" }
      },
      {
        port: 3002, listen: "127.0.0.1", protocol: "vless",
        settings: { clients: [{ id: CONFIG.UUID }], decryption: "none" },
        streamSettings: { network: "grpc", grpcSettings: { serviceName: "grpc", multiMode: true }, security: "none" }
      }
    ],
    outbounds: [
      { protocol: "freedom", tag: "direct", settings: { domainStrategy: "UseIPv4" } },
      { protocol: "blackhole", tag: "block", settings: { response: { type: "http" } } }
    ],
    policy: {
      levels: { 0: { handshake: 4, connIdle: 300, bufferSize: 10240 } }
    }
  };

  fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config, null, 2));
}

// ============================================================================
// V. 核心启动流程 (Boot - 修复版)
// ============================================================================

async function boot() {
  const { execSync } = require('child_process');
  
  // 1. Cloudflared 官方链接 (裸文件，直接下载可用)
  const argoUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  
  // 2. Xray 官方链接 (ZIP包，必须解压!)
  // 使用 v1.8.24 稳定版，确保文件存在
  const xrayZipUrl = "https://github.com/XTLS/Xray-core/releases/download/v1.8.24/Xray-linux-64.zip";

  try {
    logger.info("Starting boot sequence...");

    // 下载并设置 Cloudflared
    logger.info("Downloading Cloudflared...");
    execSync(`curl -L -o ${path.join(CONFIG.FILE_PATH, 'cloudflared')} ${argoUrl}`);
    execSync(`chmod +x ${path.join(CONFIG.FILE_PATH, 'cloudflared')}`);

    // 下载并解压 Xray
    logger.info("Downloading Xray ZIP...");
    execSync(`curl -L -o xray.zip ${xrayZipUrl}`);
    logger.info("Extracting Xray...");
    execSync(`unzip -o xray.zip -d ${CONFIG.FILE_PATH}`);
    execSync(`rm xray.zip`);
    execSync(`chmod +x ${path.join(CONFIG.FILE_PATH, 'xray')}`);

    // 生成配置
    generateXrayConfig();

    // 启动 Xray
    logger.success("Starting Xray...");
    const xrayProcess = spawn(path.join(CONFIG.FILE_PATH, 'xray'), ["-c", path.join(CONFIG.FILE_PATH, "config.json")], {
      stdio: 'inherit', detached: false
    });

    // 等待 3 秒确保 Xray 启动
    await new Promise(r => setTimeout(r, 3000));

    // 启动 Argo
    logger.success("Starting Argo...");
    startArgo(path.join(CONFIG.FILE_PATH, 'cloudflared'));

  } catch (err) {
    logger.error(`Boot failed: ${err.message}`);
    process.exit(1);
  }
}

// ============================================================================
// VI. Argo 进程管理
// ============================================================================

function startArgo(binPath) {
  const args = [
    "tunnel", "--edge-ip-version", "auto", "--no-autoupdate",
    "--protocol", "http2", "--url", `http://localhost:${CONFIG.ARGO_PORT}`
  ];

  if (CONFIG.ARGO_AUTH && !CONFIG.ARGO_AUTH.includes("{")) {
    args.splice(6, 2); // 移除 --url 参数
    args.push("run", "--token", CONFIG.ARGO_AUTH);
  }

  const argo = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  argo.stdout.on("data", (data) => {
    const log = data.toString();
    if (log.includes("trycloudflare.com")) {
      const match = log.match(/https:\/\/([\w\-]+\.trycloudflare\.com)/);
      if (match) {
        CONFIG.ARGO_DOMAIN = match[1];
        logger.success(`Argo Domain: ${match[1]}`);
      }
    }
  });
}

// ============================================================================
// VII. Web 服务
// ============================================================================

app.get("/", (req, res) => res.send("Railway Xray Running"));

app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  if (!CONFIG.ARGO_DOMAIN) return res.send("Argo not ready");
  const domain = CONFIG.ARGO_DOMAIN;
  const vless = `vless://${CONFIG.UUID}@${domain}:443?encryption=none&flow=xtls-rprx-vision&security=tls&sni=${domain}&type=tcp&fp=chrome#Railway-Vision`;
  res.send(Buffer.from(vless).toString("base64"));
});

// 启动
boot();
app.listen(CONFIG.PORT, "::", () => {
  logger.success(`HTTP Server running on port ${CONFIG.PORT}`);
});
