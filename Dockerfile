# Build stage
FROM oven/bun:1.3.12-slim AS builder

WORKDIR /app

# Copy dependency files first for better caching
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build TypeScript
RUN bun run build

# Production stage
FROM oven/bun:1.3.12-slim

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create data directory for SQLite
RUN mkdir -p .data

# Expose no ports (Discord bot uses outbound connections)
# Environment variables are passed at runtime

# Run the bot
CMD ["bun", "dist/app.js"]
