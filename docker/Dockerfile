# WhatsApp Chat RMD - User Container Dockerfile
# Multi-stage build for optimal image size

# ===========================================
# Stage 1: Builder
# ===========================================
FROM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ && \
    ln -sf python3 /usr/bin/python

# Copy package files first (better layer caching)
COPY package*.json ./

# Install all dependencies (including devDependencies for build)
RUN npm ci --include=dev

# Copy source files
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --omit=dev

# ===========================================
# Stage 2: Production
# ===========================================
FROM node:22-alpine AS production

# Labels for image metadata
LABEL org.opencontainers.image.title="WhatsApp Chat RMD"
LABEL org.opencontainers.image.description="AI-powered event extraction from WhatsApp messages"
LABEL org.opencontainers.image.version="0.5.0"
LABEL org.opencontainers.image.source="https://github.com/nityam2007/whatsapp-chat-rmd"

# Set working directory
WORKDIR /app

# Install runtime dependencies only
RUN apk add --no-cache \
    wget \
    dumb-init \
    && rm -rf /var/cache/apk/*

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Copy package files
COPY --from=builder /app/package*.json ./

# Copy node_modules from builder (already pruned)
COPY --from=builder /app/node_modules ./node_modules

# Copy built files
COPY --from=builder /app/dist ./dist

# Create data directories with proper permissions
RUN mkdir -p data/db data/vectors logs && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/webhook/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Run the application
CMD ["node", "dist/index.js"]
