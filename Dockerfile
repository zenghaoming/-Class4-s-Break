ARG NODE_IMAGE=node:24.22.0-bookworm-slim
FROM ${NODE_IMAGE}
ENV NODE_ENV=production TMPDIR=/run/class4
WORKDIR /app
RUN mkdir -p /run/class4 && chown node:node /run/class4
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY server.js game.js README.md ./
COPY public ./public
COPY tests ./tests
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz',{signal:AbortSignal.timeout(2000)}).then(response=>process.exit(response.ok?0:1))"]
CMD ["node", "--max-old-space-size=160", "server.js"]
