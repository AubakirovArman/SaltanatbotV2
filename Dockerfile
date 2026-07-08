# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build both workspaces (backend + frontend) from a full install.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

# Install workspace deps first for better layer caching. The root package-lock
# covers all three package.json manifests (root + backend + frontend).
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
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

# The SQLite DB + AES secret live under backend/data at runtime. It must be a
# writable, persistent volume (see docker-compose.yml) and is NEVER baked into
# the image. Create it and hand ownership to the non-root user.
RUN mkdir -p backend/data && chown -R node:node /app

# node:24-slim ships an unprivileged `node` user (uid 1000). Never run as root.
USER node

EXPOSE 4180

# The backend also serves the built frontend from ../../frontend/dist.
CMD ["node", "backend/dist/server.js"]
