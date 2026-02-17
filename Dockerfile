# 使用官方验证过的 Node.js 18 轻量级环境
FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 先只复制依赖描述文件，利用缓存加速
COPY package*.json ./

# 【关键一步】强制执行安装，显示详细日志，确保 express 等包被装入
RUN npm install --verbose

# 复制其余所有代码文件
COPY . .

# 暴露端口（配合 Northflank 的 8080）
EXPOSE 8080

# 启动命令
CMD ["node", "index.js"]
