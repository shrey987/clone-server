FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    curl \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install ONLY Vercel CLI — NOT claude-code CLI (we use SDK directly)
RUN npm install -g vercel

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
CMD ["node", "server.js"]
