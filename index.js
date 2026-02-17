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
    // 1. 自动识别 UUID，如果环境变量没有，则用你原来的默认值
    UUID: process.env.UUID || "21798a3b-9b6f-4081-a5a3-aea0eb1239e9",
    // 2. 自动识别端口，适配 Northflank 的 8080
    PORT: parseInt(process.env.PORT) || 8080,
    XRAY_PORT: 3000,
    // 3. 【核心稳定改动】全自动域名识别，不再写死！
    // 优先从环境取，没有就设为 null，由后面的逻辑动态抓取
    RAIL_DOMAIN: process.env.RAILWAY_STATIC_URL || process.env.NF_HOSTS?.split(',')[0] || null,
    SUB_PATH: (process.env.SUB_PATH || "sub").replace(/^\/+/, ""),
    FILE_PATH: "./bin_v184_final",
};

if (!fs.existsSync(CONFIG.FILE_PATH)) fs.mkdirSync(CONFIG.FILE_PATH, { recursive: true });

function cleanup() {
    try { execSync("pkill -9 xray 2>/dev/null || true", { stdio: 'ignore' }); } catch (e) {}
}

async function boot() {
    const xrayZipUrl = "https://github.com/XTLS/Xray-core/releases/download/v1.8.4/Xray-linux-64.zip";
    try {
        console.log("[INFO] 🚀 正在部署全自动适配版 v1.8.4...");
        cleanup();
        const xrayPath = path.join(CONFIG.FILE_PATH, 'xray');
        if (!fs.existsSync(xrayPath)) {
            console.log("[下载] Xray v1.8.4...");
            const response = await axios({ url: xrayZipUrl, method: 'GET', responseType: 'stream' });
            await response.data.pipe(unzipper.Extract({ path: CONFIG.FILE_PATH })).promise();
            const bin = fs.readdirSync(CONFIG.FILE_PATH).find(f => f.toLowerCase().includes('xray'));
            if (bin && bin !== 'xray') { fs.renameSync(path.join(CONFIG.FILE_PATH, bin), xrayPath); }
            fs.chmodSync(xrayPath, 0o755);
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
        fs.writeFileSync(path.join(CONFIG.FILE_PATH, "config.json"), JSON.stringify(config));
        const xray = spawn(xrayPath, ["-c", path.join(CONFIG.FILE_PATH, "config.json")], { stdio: 'inherit' });
        xray.on("exit", () => setTimeout(boot, 30000));
    } catch (err) {
        setTimeout(boot, 10000);
    }
}

// 动态域名获取逻辑：你用什么域名访问，它就生成什么节点的域名
const getHost = (req) => CONFIG.RAIL_DOMAIN || req.get('host');

app.get("/", (req, res) => {
    const host = getHost(req);
    res.send(`
        <div style="font-family:sans-serif;text-align:center;padding:50px;">
            <h1>🚀 Universal Node Running</h1>
            <p>版本: v1.8.4 Stable</p>
            <p>动态域名: <code>${host}</code></p>
            <p>订阅地址: <a href="/${CONFIG.SUB_PATH}">点击查看订阅链接</a></p>
        </div>
    `);
});

app.get(`/${CONFIG.SUB_PATH}`, (req, res) => {
    const host = getHost(req);
    // 生成万能 VLESS 链接
    const vless = `vless://${CONFIG.UUID}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&path=%2Fxray#Universal-Node`;
    res.send(Buffer.from(vless).toString("base64"));
});

boot();
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
    if (req.url === '/xray') {
        const target = net.connect(CONFIG.XRAY_PORT, '127.0.0.1', () => {
            let headerStr = `${req.method} ${req.url} HTTP/1.1\r\n`;
            for (let k in req.headers) { headerStr += `${k}: ${req.headers[k]}\r\n`; }
            headerStr += '\r\n';
            target.write(headerStr);
            target.write(head);
            socket.pipe(target);
            target.pipe(socket);
        });
        target.on('error', () => socket.end());
    }
});
server.listen(CONFIG.PORT, "0.0.0.0");
