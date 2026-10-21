# Multi-stage build for Moiré frontend
FROM node:20-alpine AS build

# Install pnpm (pinned to the version the lockfile was written with)
RUN npm install -g pnpm@10.22.0

WORKDIR /app

# Copy workspace files first
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy frontend package.json
COPY packages/frontend/package.json ./packages/frontend/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy frontend source code
COPY packages/frontend/ ./packages/frontend/

# Build the app
RUN pnpm -C packages/frontend build

# Production stage with nginx
FROM nginx:alpine AS production

# Install curl for health checks
RUN apk add --no-cache curl

# Copy built assets
COPY --from=build /app/packages/backend/src/web /usr/share/nginx/html

# Copy nginx configuration for SPA routing
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost/ || exit 1

# Start nginx
CMD ["nginx", "-g", "daemon off;"]