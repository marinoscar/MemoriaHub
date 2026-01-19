# MemoriaHub Worker Dockerfile
# Multi-stage build for development and production

# =============================================================================
# Base Stage: Common dependencies
# =============================================================================
FROM node:20-alpine AS base

# Install security updates and dependencies for image/video processing
RUN apk add --no-cache \
    curl \
    dumb-init \
    # Image processing dependencies (for sharp)
    vips-dev \
    fftw-dev \
    build-base \
    python3 \
    # Video processing (FFmpeg for video thumbnails)
    ffmpeg \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# =============================================================================
# Dependencies Stage: Install all dependencies
# =============================================================================
FROM base AS deps

# Copy package files for dependency installation
COPY package*.json ./
COPY apps/worker/package*.json ./apps/worker/
COPY packages/shared/package*.json ./packages/shared/

# Install all dependencies (including devDependencies for build)
# Use npm install if no lock file exists, npm ci if it does
RUN if [ -f package-lock.json ]; then \
      npm ci --workspace=apps/worker --workspace=packages/shared; \
    else \
      npm install --workspace=apps/worker --workspace=packages/shared; \
    fi

# =============================================================================
# Development Stage: Hot-reload development server
# =============================================================================
FROM deps AS development

# Copy source code
COPY apps/worker ./apps/worker
COPY packages/shared ./packages/shared
COPY tsconfig*.json ./

WORKDIR /app/apps/worker

# Expose health check port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3001/healthz || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start development server with hot-reload
CMD ["npm", "run", "dev"]

# =============================================================================
# Builder Stage: Build for production
# =============================================================================
FROM deps AS builder

# Copy source code
COPY apps/worker ./apps/worker
COPY packages/shared ./packages/shared
COPY tsconfig*.json ./

WORKDIR /app/apps/worker

# Build the application
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# =============================================================================
# Production Stage: Minimal production image
# =============================================================================
FROM node:20-alpine AS production

# Install runtime dependencies only
RUN apk add --no-cache \
    curl \
    dumb-init \
    vips \
    ffmpeg \
    && rm -rf /var/cache/apk/*

# Create temp directory for video processing
RUN mkdir -p /tmp/worker

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001

# Copy only production artifacts
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/worker/package*.json ./apps/worker/
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared/package*.json ./packages/shared/
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

WORKDIR /app/apps/worker

# Set production environment
ENV NODE_ENV=production

# Switch to non-root user
USER nodejs

# Expose health check port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3001/healthz || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start production worker
CMD ["node", "dist/index.js"]
