FROM node:23-alpine

RUN apk add --no-cache \
    redis

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application files
COPY . .

# Copy .env
COPY .env .env

# Build TypeScript (install dev dependencies temporarily for build)
RUN npm install --only=dev && \
    npm run build && \
    npm prune --production

# Expose the port
EXPOSE 3000

# Health check to ensure the container is running properly
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Set the command to run the application
CMD ["sh", "-c", "redis-server --daemonize yes && node dist/index.js"]
