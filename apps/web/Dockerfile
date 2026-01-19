# MemoriaHub Web Frontend Dockerfile
# Multi-stage build for development and production

# =============================================================================
# Base Stage: Common dependencies
# =============================================================================
FROM node:20-alpine AS base

# Install security updates
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
COPY apps/web/package*.json ./apps/web/
COPY packages/shared/package*.json ./packages/shared/

# Install all dependencies (including devDependencies for build)
# Use npm install if no lock file exists, npm ci if it does
RUN if [ -f package-lock.json ]; then \
      npm ci --workspace=apps/web --workspace=packages/shared; \
    else \
      npm install --workspace=apps/web --workspace=packages/shared; \
    fi

# =============================================================================
# Development Stage: Vite dev server with HMR
# =============================================================================
FROM deps AS development

# Copy source code
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY tsconfig*.json ./

WORKDIR /app/apps/web

# Expose Vite dev server port
EXPOSE 5173

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5173 || exit 1

# Use dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start Vite dev server (bind to 0.0.0.0 for Docker access)
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# =============================================================================
# Builder Stage: Build for production
# =============================================================================
FROM deps AS builder

# Build arguments for environment variables
ARG VITE_API_URL=/api

# Copy source code
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
COPY tsconfig*.json ./

WORKDIR /app/apps/web

# Set build-time environment variables
ENV VITE_API_URL=${VITE_API_URL}

# Build the application
RUN npm run build

# =============================================================================
# Production Stage: Nginx serving static files
# =============================================================================
FROM nginx:alpine AS production

# Install curl for health checks
RUN apk add --no-cache curl

# Copy custom nginx config for SPA
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built static files
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
