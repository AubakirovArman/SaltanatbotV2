# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build both workspaces (backend + frontend) from a full install.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

# Install workspace deps first for better layer caching. The root package-lock
# covers the workspace manifests.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/arbitrage-sdk/package.json packages/arbitrage-sdk/package.json
COPY packages/backtest-core/package.json packages/backtest-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/execution-core/package.json packages/execution-core/package.json
COPY packages/pine-compiler/package.json packages/pine-compiler/package.json
COPY packages/plugin-core/package.json packages/plugin-core/package.json
COPY packages/strategy-core/package.json packages/strategy-core/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
RUN npm ci

# Copy the rest of the sources and build. `npm run build` runs the build script
# in every workspace: backend -> tsc to backend/dist, frontend -> vite to frontend/dist.
COPY . .
RUN npm run build

# Produce a production-only node_modules for the runtime stage (drops devDeps
# like typescript/vite/vitest/biome that are useless at runtime).
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — slim runtime. Copies only built output + prod deps, runs non-root.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
ENV NODE_ENV=production
# Bind to all interfaces INSIDE the container — the host/compose/reverse-proxy
# is what actually decides external exposure via its port mapping.
ENV HOST=0.0.0.0
ENV PORT=4180
WORKDIR /app

# Copy production dependencies and the compiled output only.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
# Keep the verified SQLite backup/restore utility in the runtime image. Compose
# stores backend/data in a named volume, so operators must be able to run this
# script against that mounted volume from the service container.
COPY --from=build /app/scripts/runtime-data.mjs ./scripts/runtime-data.mjs
# npm workspaces are relative symlinks under node_modules; copy their runtime
# package roots so those links remain valid in the slim image.
COPY --from=build /app/packages ./packages

# Legacy trading state remains in SQLite under backend/data; identity, sessions,
# workspaces and compute jobs live in the separate PostgreSQL service. Neither
# database nor its secrets are baked into the image.
RUN mkdir -p backend/data && chown -R node:node /app

# node:24-slim ships an unprivileged `node` user (uid 1000). Never run as root.
USER node

EXPOSE 4180

# The backend also serves the built frontend from ../../frontend/dist.
CMD ["node", "backend/dist/server.js"]
