const express = require("express");
const app = express();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const unzipper = require("unzipper");
const http = require("http");
const net = require("net");

const CONFIG = {
  UUID: process.env.UUID || "9afd1229-b893-40c1-84dd-51e7ce204913",
  PORT: parseInt(process.env.PORT) || 8080,
  XRAY_PORT: 3000,
  SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
  FILE_PATH: "./bin_v184_final",
};

if (!fs.existsSync(CONFIG.FILE_PATH)) {
  fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });
}

function cleanup() {
  try {
    execSync("pkill -9 xray 2>/dev/null || true", { stdio: 'ignore' });
  } catch (e) {}
}

const getHost = (req) => {
  return process.env.RAILWAY_STATIC_URL || req.headers.host || "localhost";
};

async function boot() {
  const xrayZipUrl = "https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip";
  
  try {
    console.log("[INFO] 正在部署 Xray v1.8.4...");
    cleanup();
    
    const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
    
    if (!fs.existsSync(xrayPath)) {
      console.log("[下载] Xray v1.8.4...");
      const response = await axios({ 
        url: xrayZipUrl, 
        method: 'GET', 
        responseType: 'stream' 
      });
      await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
      
      const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
      if (bin && bin !== 'xray') {
        fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath);
      }
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
      console.error("[错误] Xray 退出 (" + code + ")，30秒后重启...");
      setTimeout(boot, 30000);
    });
    
    console.log("[✓] Xray 核心运行中");
    
  } catch (err) {
    console.error("[ERROR] 启动失败: " + err.message);
    setTimeout(boot, 10000);
  }
}

app.get("/", (req, res) => {
  const host = getHost(req);
  res.send("<h1>Railway Xray Proxy</h1><p>Version: v1.8.4</p><p>订阅: <code>https://" + host + "/" + CONFIG.SUB_PATH + "</code></p><p>手动导入: 访问订阅链接，复制内容，解码后导入</p>");
});

app.get("/" + CONFIG.SUB_PATH, (req, res) => {
  const host = getHost(req);
  
  // 生成 VLESS 链接
  const vlessUrl = "vless://" + CONFIG.UUID + "@" + host + ":443?encryption=none&security=tls&sni=" + host + "&type=ws&path=%2Fxray#Railway-" + host;
  
  // 转换为 base64（标准 v2ray 订阅格式）
  const base64Content = Buffer.from(vlessUrl).toString("base64");
  
  // 设置响应头（兼容 v2rayN）
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Profile-Update-Interval", "24");
  res.setHeader("Subscription-Userinfo", "upload=0; download=0; total=10737418240; expire=0");
  
  // 返回 base64（标准格式，单个节点直接返回）
  res.send(base64Content);
});

app.get("/link", (req, res) => {
  const host = getHost(req);
  const vlessUrl = "vless://" + CONFIG.UUID + "@" + host + ":443?encryption=none&security=tls&sni=" + host + "&type=ws&path=%2Fxray#Railway-" + host;
  res.send("<h2>手动导入链接</h2><p>复制下面的链接，在 v2rayN 中选择 '从剪贴板导入批量URL'：</p><textarea style='width:100%;height:100px'>" + vlessUrl + "</textarea>");
});

app.get("/health", (req, res) => {
  res.json({
    status: "online",
    version: "v1.8.4",
    domain: getHost(req),
    uptime: process.uptime()
  });
});

boot();

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/xray') {
    const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
      let headerStr = req.method + " " + req.url + " HTTP/1.1\r\n";
      for (let k in req.headers) {
        headerStr += k + ": " + req.headers[k] + "\r\n";
      }
      headerStr += '\r\n';
      
      target.write(headerStr);
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
  console.log("[✓] 服务已启动，端口: " + CONFIG.PORT);
});

process.on("SIGTERM", () => {
  console.log("[关闭] 收到关闭信号");
  cleanup();
  process.exit(0);
});
