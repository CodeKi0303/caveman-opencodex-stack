FROM docker.io/library/node:24.14.1-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
# A company CA is a build secret, never copied into the image.
# Podman forwards build-shell proxy variables without ARG/ENV image layers.
RUN --mount=type=secret,id=corp_ca \
    if [ -s /run/secrets/corp_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/corp_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund
RUN --mount=type=secret,id=corp_ca \
    if [ -s /run/secrets/corp_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/corp_ca; fi; \
    NODE_USE_ENV_PROXY=1 CAVEMAN_HOME=/opt/caveman CAVEMAN_TELEMETRY=0 node node_modules/@caveman-ai/cli/dist/index.js setup --install
COPY src ./src
COPY scripts ./scripts
COPY config ./config
COPY licenses ./licenses
COPY THIRD_PARTY.md LICENSE ./
ENV NODE_USE_ENV_PROXY=1
ENV PATH="/app/node_modules/.bin:/opt/caveman/bin:${PATH}"
ENV OPENCODEX_HOME=/state/opencodex CODEX_HOME=/state/codex CAVEMAN_HOME=/state/caveman
ENV CAVEMAN_CCR_DB=/state/caveman/ccr.db CAVEMAN_CONFIG=/app/config/chain.yaml
ENV CAVEMAN_LISTEN=127.0.0.1:8787 CAVE_SSRF_ALLOWLIST=127.0.0.1
ENV CAVEMAN_RECOVERY=mcp CAVEMAN_TELEMETRY=0 CAVEMAN_OFFLINE=1
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=45s CMD node /app/scripts/health.mjs
CMD ["node", "/app/src/supervisor.mjs"]
