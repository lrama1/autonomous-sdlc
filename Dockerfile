# The platform image: the API (which also serves the built web app) and the Model Gateway. One image, two commands.
#   docker build -t sdlc-platform .
#   api:     node --import tsx apps/api/src/main.ts      (the default)
#   gateway: node --import tsx apps/gateway/src/main.ts
# TypeScript runs through tsx, as it does in local development, so there is one way to run the code.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 # The CA that signs Amazon RDS certificates, so the database connection is encrypted and verified.
 && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/ssl/rds-global-bundle.pem \
 && corepack enable

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @sdlc/web build \
 && chown -R node:node /app

USER node
ENV NODE_ENV=production \
    SDLC_ENV=aws-sandbox \
    API_PORT=8080 \
    WEB_DIR=apps/web/dist
EXPOSE 8080 8787
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
