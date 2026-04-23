# Build stage
FROM node:22-slim AS builder

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable

# Copy dependency files first for better caching
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Production stage
FROM node:22-slim

WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite
RUN mkdir -p .data

# Expose no ports (Discord bot uses outbound connections)
# Environment variables are passed at runtime

# Run the bot
CMD ["node", "dist/app.js"]
