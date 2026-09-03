# ─── Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev so no test tooling ships. `npm ci` when a lockfile exists, so the
# image is built from resolved versions rather than whatever the registry
# serves today.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ─── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine
# Patch the base image at build time. An image pinned to a digest with known
# CVEs in libssl is not more secure for being reproducible.
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Non-root. A container escape is a much worse day when the process was uid 0,
# and nothing here needs to write to the filesystem or bind a low port.
USER node

EXPOSE 8080

# No shell form, so node is PID 1 and receives SIGTERM directly — which is what
# the drain handler in src/index.js is listening for. Wrapped in a shell, the
# signal goes to the shell and tasks are killed mid-transaction on every deploy.
CMD ["node", "src/index.js"]
