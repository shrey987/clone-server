FROM node:20-slim

# System deps for Chromium + Python
RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    git \
    ca-certificates \
    wget \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Vercel CLI
RUN npm install -g vercel

WORKDIR /app
COPY package*.json ./
RUN npm install --production

# Install Playwright Chromium + its OS-level deps
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
