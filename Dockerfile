# Europa Live — zero-dependency Node service. Multi-stage keeps the image small and reproducible.
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
COPY package.json ./
COPY server ./server
COPY public ./public
COPY data ./data
RUN addgroup -S europa && adduser -S europa -G europa && chown -R europa:europa /app
USER europa
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.js"]
