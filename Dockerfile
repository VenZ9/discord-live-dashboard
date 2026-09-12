FROM node:20-alpine

# This app holds a persistent Discord Gateway (WebSocket) connection, so it must
# run as a long-lived process - not as a serverless/edge function.

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Healthcheck so hosts (Railway, Render, Fly) can confirm liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
