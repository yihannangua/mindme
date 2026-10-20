# 发布镜像只接收已核验的编译产物；配置和持久数据不得进入构建上下文。
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
ARG SOURCE_REPOSITORY=unknown
ARG SOURCE_SHA=unknown
ARG SOURCE_CI_RUN=unknown
ARG SOURCE_PACKAGE_SHA256=unknown
ARG APP_VERSION=unknown
LABEL org.opencontainers.image.source="https://github.com/yihannangua/mindme" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      com.mindme.ci.run="${SOURCE_CI_RUN}" \
      com.mindme.package.sha256="${SOURCE_PACKAGE_SHA256}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3180 DATABASE_PATH=/var/lib/mindme/mindme.sqlite STATIC_DIR=/app/dist
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && mkdir -p /var/lib/mindme && chown node:node /var/lib/mindme
COPY --chown=node:node dist ./dist
COPY --chown=node:node dist-server ./dist-server
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.txt ./
USER node
EXPOSE 3180
CMD ["node", "dist-server/index.js"]
