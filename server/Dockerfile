# ─── Build ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev so no test tooling ships. `npm ci` when a lockfile exists, so the
# image is built from resolved versions rather than whatever the registry
# serves today.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# The software bill of materials for the tree that actually ships.
#
# Generated HERE, in the layer that resolved the dependencies, rather than in
# CI. The point of an SBOM is to answer "was the thing we deployed affected by
# this advisory" months later, and an SBOM produced by a separate `npm install`
# in a separate job is a statement about a tree that resolved at a different
# moment. `npm ci --omit=dev` above and this command see the same node_modules,
# so the answer is about the image.
#
# `npm sbom` is built into npm 10 and reaches the network for nothing. The
# alternative was `npx @cyclonedx/cyclonedx-npm@latest`, which downloads and
# executes an unpinned package from the registry — inside the step whose entire
# purpose is supply-chain assurance.
RUN npm sbom --sbom-format cyclonedx --omit=dev > /app/sbom.json \
 && node -e "const n=require('/app/sbom.json').components.length; \
             if (!n) { console.error('SBOM has no components'); process.exit(1); } \
             console.log('SBOM: '+n+' components')"

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
# Travels WITH the image, at a fixed path, so the bill of materials for a
# running container can be read out of the container rather than reconstructed
# from whichever CI run is believed to have built it:
#
#   aws ecs execute-command ... --command "cat /app/sbom.json"
COPY --from=deps /app/sbom.json ./sbom.json

# Non-root. A container escape is a much worse day when the process was uid 0,
# and nothing here needs to write to the filesystem or bind a low port.
USER node

EXPOSE 8080

# No shell form, so node is PID 1 and receives SIGTERM directly — which is what
# the drain handler in src/index.js is listening for. Wrapped in a shell, the
# signal goes to the shell and tasks are killed mid-transaction on every deploy.
CMD ["node", "src/index.js"]
