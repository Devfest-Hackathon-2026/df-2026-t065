# AllergyBridge: standalone Next.js build. No credentials or API keys.
# Default card-only setup is documented in README.md.
ARG BUILD_NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_NODE_IMAGE=node:22-bookworm-slim

# ---- build: full dependencies, compile, produce .next/standalone -------------
FROM ${BUILD_NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime: only the traced standalone server + static assets -------------
FROM ${RUNTIME_NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0
# server.js, the traced production node_modules and .next/server
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 8080
CMD ["node", "server.js"]
