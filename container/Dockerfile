# Imgbot 超大图兜底容器（DESIGN.md §6.3）
#
# 分工：
#   - Worker 侧：MIT/Apache 的 wasm 编解码（@jsquash / oxipng），受 128MB 内存墙约束
#   - 本容器：>8MP 或 >15MB 的图，用原生工具链重活（jpegtran / optipng / gifsicle / sharp）
#
# 许可（§9-R7 定案）：GPL 的 gifsicle 只在这里以独立进程 CLI 调用，不链接进 Worker 产物。

FROM node:22-slim

# jpegtran 来自 libjpeg-turbo-progs；optipng / gifsicle 直接可用。
# ca-certificates 供 sharp 的下载/校验路径（构建期），运行时保留成本极低。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libjpeg-turbo-progs \
    optipng \
    gifsicle \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 容器内独立依赖（与根 package.json 无关），先装依赖再加代码以吃到层缓存。
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

COPY server.mjs ./server.mjs

ENV NODE_ENV=production \
    PORT=8000

EXPOSE 8000

# 无状态、无持久卷：临时文件只落 /tmp，请求结束即删。
USER node

CMD ["node", "server.mjs"]
