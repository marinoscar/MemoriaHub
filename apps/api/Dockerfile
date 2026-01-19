# MemoriaHub API Dockerfile
# Multi-stage build for development and production

# =============================================================================
# Base Stage: Common dependencies
# =============================================================================
FROM node:20-alpine AS base

# Install security updates and common dependencies
RUN apk add --no-cache \
    curl \
    dumb-init \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# =============================================================================
# Dependencies Stage: Install all dependencies
# =============================================================================
FROM base AS deps

# Copy package files for dependency installation
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY packages/shared/package*.json ./packages/shared/

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=apps/api --workspace=packages/shared

# =============================================================================
# Development Stage: Hot-reload development server
# =============================================================================
FROM deps AS development

# Copy source code
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
COPY tsconfig*.json ./

WORKDIR /app/apps/api

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/healthz || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start development server with hot-reload
CMD ["npm", "run", "dev"]

# =============================================================================
# Builder Stage: Build for production
# =============================================================================
FROM deps AS builder

# Copy source code
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
COPY tsconfig*.json ./

WORKDIR /app/apps/api

# Build the application
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# =============================================================================
# Production Stage: Minimal production image
# =============================================================================
FROM base AS production

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001

# Copy only production artifacts
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nodejs:nodejs /app/apps/api/package*.json ./apps/api/
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nodejs:nodejs /app/packages/shared/package*.json ./packages/shared/
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules

WORKDIR /app/apps/api

# Set production environment
ENV NODE_ENV=production

# Switch to non-root user
USER nodejs

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/healthz || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start production server
CMD ["node", "dist/index.js"]
