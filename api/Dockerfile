# API do gba: Node sem dependências, só o server.mjs.
FROM node:22.23.5-alpine
ARG VERSAO=dev
ENV APP_VERSAO=$VERSAO NODE_ENV=production
# upgrade: correções de segurança do Alpine sem esperar a imagem base.
# npm/yarn saem: a API não tem dependências, e eles só trariam CVEs (trivy no CI).
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
