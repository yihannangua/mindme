ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM ${NODE_IMAGE}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3180 DATABASE_PATH=/var/lib/mindme/mindme.sqlite STATIC_DIR=/app/dist
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && mkdir -p /var/lib/mindme && chown node:node /var/lib/mindme
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.txt ./
USER node
EXPOSE 3180
CMD ["node", "dist-server/index.js"]
