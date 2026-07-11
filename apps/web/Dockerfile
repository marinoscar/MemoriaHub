# =============================================================================
# Web Dockerfile - Multi-stage build
# =============================================================================
# Build context: the REPOSITORY ROOT (see infra/compose/base.compose.yml:
# `context: ../.., dockerfile: apps/web/Dockerfile`), matching apps/api's
# Dockerfile so both apps follow the same npm-workspace-aware convention.
# apps/web has no local workspace package dependency today, but building
# from the repo root means a future one (e.g. a shared UI or types package)
# won't require touching this file again.
#
# WORKDIR is /app (repo root) through the deps stage so `npm install`
# resolves workspaces correctly. Runtime stages switch WORKDIR to
# /app/apps/web so npm scripts and CMD entries behave exactly as they did
# when the context was apps/web alone.
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
FROM node:26-alpine AS base
WORKDIR /app

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
# Root workspace manifests plus apps/web's own manifest, so npm workspaces
# can resolve/link correctly even though apps/web has no local package deps.
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
# --ignore-scripts: before this context widening, the build context was
# scoped to apps/web, so the root package.json (and its postinstall,
# scripts/patch-react-transition-group.js) was never even visible to this
# install — the web image has always shipped with an unpatched
# react-transition-group. Root package.json is now visible since the context
# is the repo root, so the postinstall WOULD run without this flag; doing so
# changes behavior and breaks the production `vite build` (rolldown-vite
# rejects a subpath the patch's exports map doesn't cover). --ignore-scripts
# keeps this build byte-for-byte equivalent to the pre-widening behavior.
RUN npm install --ignore-scripts

# -----------------------------------------------------------------------------
# Development stage
# -----------------------------------------------------------------------------
FROM base AS development
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY apps/web ./apps/web
WORKDIR /app/apps/web
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/tsconfig.base.json /app/tsconfig.base.json
COPY apps/web ./apps/web
WORKDIR /app/apps/web
RUN npm run build

# -----------------------------------------------------------------------------
# Production stage (nginx to serve static files)
# -----------------------------------------------------------------------------
FROM nginx:alpine AS production
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
