FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI and Vercel CLI globally
RUN npm install -g @anthropic-ai/claude-code vercel

# Create non-root user (Claude Code refuses to run as root with --dangerously-skip-permissions)
RUN useradd -m -s /bin/bash appuser

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
