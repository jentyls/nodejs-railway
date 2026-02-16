const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const unzipper = require("unzipper");
const http = require("http");
const net = require("net");

// --- 1. 基础配置 ---
const CONFIG = {
  UUID: process.env.UUID || "606d77a4-93da-49c7-83a5-b7fe52f2196f",
  PORT: parseInt(process.env.PORT) || 8080,
  XRAY_PORT: 3000,
  SUB_PATH: process.env.SUB_PATH || "sub",
  FILE_PATH: "./bin_v184_final",
};

// --- 2. 辅助函数 ---
if (!fs.existsSync(CONFIG.FILE_PATH)) {
  fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });
}

function cleanup() {
  try {
    execSync("pkill -9 xray 2>/dev/null || true", { stdio: 'ignore' });
  } catch (e) {}
}

// 动态获取当前访问域名
const getHost = (req) => {
  return process.env.RAILWAY_STATIC_URL || req.headers.host || "localhost";
};

// --- 3. 启动 Xray ---
async function boot() {
  const xrayZipUrl = "https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip";
  
  try {
    console.log("[INFO] 🚀 正在初始化 Xray v1.8.4...");
    cleanup();
    
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    
    if (!fs.existsSync(xrayPath)) {
      console.log("[下载] Xray 核心文件中...");
      const response = await axios({ 
        url: xrayZipUrl, 
        method: 'GET', 
        responseType: 'stream' 
      });
      
      const zipPath = path.join(CONFIG.FILE_PATH, 'xray.zip');
      const writer = fs.createWriteStream(zipPath);
      response.data.pipe(writer);
      await new Promise((resolve) => writer.on('finish', resolve));
      
      await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: CONFIG.FILE_PATH }))
        .promise();
      
      fs.chmodSync(xrayPath, 0o755);
      console.log("[✓] 下载完成");
    } else {
      console.log("[✓] Xray 已存在");
    }

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
    
    fs.writeFileSync(
      path.join(CONFIG.FILE_PATH, "config.json"), 
      JSON.stringify(config, null, 2)
    );
    
    const xray = spawn(xrayPath, [
      "-c", 
      path.join(CONFIG.FILE_PATH, "config.json")
    ], { 
      stdio: 'inherit' 
    });
    
    xray.on("exit", (code) => {
      console.log(`[警告] Xray 退出 (${code})，30秒后重启...`);
      setTimeout(boot, 30000);
    });
    
    console.log("[✓] Xray 核心运行中");
    
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    setTimeout(boot, 10000);
  }
}

// --- 4. 路由定义 ---
app.get("/", (req, res) => {
  const host = getHost(req);
  res.send(`
    <h1>🚀 Railway Xray Online</h1>
    <p>订阅路径: <code>/${CONFIG.SUB_PATH}</code></p>
    <p>当前域名: <code>${host}</code></p>
  `);
});

app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
  const host = getHost(req);
  const vless = `vless://${CONFIG.UUID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=%2Fxray#Railway-Auto`;
  res.send(Buffer.from(vless).toString("base64"));
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

boot();

// --- 5. 建立 HTTP 到 Xray WS 的转发 ---
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/xray') {
    const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
      // 构造完整的 WebSocket 握手请求
      const headers = [
        `GET ${req.url} HTTP/1.1`,
        `Host: ${req.headers.host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] || 'dGhlIHNhbXBsZSBub25jZQ=='}`,
        `Sec-WebSocket-Version: 13`,
        `\r\n`
      ].join('\r\n');
      
      target.write(headers);
      target.write(head);
      
      socket.pipe(target);
      target.pipe(socket);
    });
    
    target.on('error', () => socket.end());
    socket.on('error', () => target.end());
  } else {
    socket.end();
  }
});

server.listen(CONFIG.PORT, "0.0.0.0", () => {
  console.log(`[✓] 服务已就绪，端口: ${CONFIG.PORT}`);
});

process.on("SIGTERM", () => {
  console.log("[关闭] 收到关闭信号");
  cleanup();
  process.exit(0);
});
```

---

## 🎯 **主要修正**

1. ✅ 所有模板字符串从 **反引号函数调用** 改为 **括号+模板字符串**
2. ✅ 添加了 WebSocket 握手的 `Sec-WebSocket-Key` 头（提高兼容性）
3. ✅ 优化了 WebSocket upgrade 转发逻辑
4. ✅ 添加了进程优雅关闭处理

---

## 📋 **部署后应该看到的日志**
```
[INFO] 🚀 正在初始化 Xray v1.8.4...
[✓] Xray 已存在
[✓] Xray 核心运行中
Xray 1.8.4 (Xray, Penetrates Everything.) Custom (go1.21.0 linux/amd64)
2026/02/16 04:32:22 [Info] infra/conf/serial: Reading config: bin_v184_final/config.json
[✓] 服务已就绪，端口: 8080
