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

# Download @vladmandic/human model files (blazeface-back + faceres for detect+embed)
RUN mkdir -p /app/models/human && \
    (wget -q -P /app/models/human \
      https://vladmandic.github.io/human-models/models/blazeface-back.json \
      https://vladmandic.github.io/human-models/models/blazeface-back.bin \
      https://vladmandic.github.io/human-models/models/faceres.json \
      https://vladmandic.github.io/human-models/models/faceres-shard1 \
      || echo "Model download failed - models will be fetched at runtime")

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
