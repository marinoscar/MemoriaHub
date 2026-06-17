# =============================================================================
# API Dockerfile - Multi-stage build
# =============================================================================

# -----------------------------------------------------------------------------
# Base stage
# -----------------------------------------------------------------------------
FROM node:26-alpine AS base
WORKDIR /app
# Install OpenSSL for Prisma compatibility and ffmpeg for video processing
RUN apk add --no-cache openssl openssl-dev ffmpeg

# -----------------------------------------------------------------------------
# Dependencies stage
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/
# Using npm install since this is a workspace package without its own lock file
# Set dummy DATABASE_URL for Prisma generate (actual connection not needed at build time)
RUN npm install --ignore-scripts && \
    DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy" npx prisma generate

# Download @vladmandic/human model files (blazeface-back detector + faceres
# descriptor) for offline in-process face detection. The build FAILS if any
# file is missing so we never ship an incomplete model set silently.
ENV HUMAN_MODELS_BASE=https://vladmandic.github.io/human-models/models
RUN mkdir -p /app/models/human && \
    for f in blazeface-back.json blazeface-back.bin faceres.json faceres.bin; do \
      wget -q -O "/app/models/human/$f" "$HUMAN_MODELS_BASE/$f" || { echo "FATAL: failed to download Human model $f"; exit 1; }; \
    done && \
    echo "Human models bundled:" && ls -la /app/models/human

# -----------------------------------------------------------------------------
# Development stage
# -----------------------------------------------------------------------------
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/models /app/models
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# Production stage
# -----------------------------------------------------------------------------
FROM base AS production
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/models /app/models
COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/
EXPOSE 3000
CMD ["npm", "run", "start:prod"]
