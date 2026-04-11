# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev

RUN npm install curl

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Non-root user for security
RUN addgroup -S bridge && adduser -S bridge -G bridge
    
COPY --from=deps /app/node_modules ./node_modules
COPY bridge.js .
COPY package.json .

USER bridge

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://opencode-bridge:5000/health || exit 1

CMD ["node", "bridge.js"]
