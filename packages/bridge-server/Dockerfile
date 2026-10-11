# Deployed Teal Brick bridge (opt2). Build context: repository root.
#   docker build -f packages/bridge-server/Dockerfile .
# Public image, no secrets baked in. Runtime env: TB_PORTAL_URL, TB_ENROL_CODE, TB_KEK, TB_PUBLIC_URL,
# TB_DATA_DIR (mount a provider volume at /data; no Dockerfile VOLUME, Railway refuses it), PORT, TB_INTERNAL_PORT.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @opt2-tealbrick/bridge --filter @opt2-tealbrick/bridge-server run build \
 && pnpm --filter @opt2-tealbrick/bridge-server deploy --prod /out

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production TB_DATA_DIR=/data PORT=8080 TB_INTERNAL_PORT=8788
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
