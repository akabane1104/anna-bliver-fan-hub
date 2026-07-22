FROM node:20-bookworm-slim

WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/scripts ./scripts
COPY LICENSE NOTICE ./

RUN mkdir -p uploads/branding uploads/prizes \
    && chown -R node:node /app/uploads

ENV NODE_ENV=production
USER node

EXPOSE 5000

CMD ["node", "src/server.js"]
