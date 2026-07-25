FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY services/bilibili-listener/package.json services/bilibili-listener/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node services/bilibili-listener/src ./services/bilibili-listener/src
COPY --chown=node:node backend/src/schemas /app/backend/src/schemas
COPY --chown=node:node backend/src/utils/liveEventConfig.js /app/backend/src/utils/liveEventConfig.js
COPY --chown=node:node backend/src/config/runtimeConfig.js /app/backend/src/config/runtimeConfig.js

RUN mkdir -p /var/lib/bilibili-listener \
    && chown -R node:node /var/lib/bilibili-listener

WORKDIR /app/services/bilibili-listener
USER node

CMD ["node", "--experimental-websocket", "src/cli.js", "service"]
