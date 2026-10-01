FROM node:22-bookworm-slim

WORKDIR /opt/novda

COPY ops/deploy/package.json ops/deploy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY apps/server ./apps/server
COPY packages/contracts/keys/licensePublicKey.cjs ./packages/contracts/keys/licensePublicKey.cjs
COPY worker-bot/webapp/index.html ./worker-bot/webapp/index.html
COPY ops/deploy/migrateProduction.cjs ./ops/deploy/migrateProduction.cjs
COPY ops/deploy/importSqliteBaseline.cjs ./ops/deploy/importSqliteBaseline.cjs
COPY ops/deploy/verifyProductionDatabase.cjs ./ops/deploy/verifyProductionDatabase.cjs
COPY packages/domain/periodWriteGuard.cjs ./packages/domain/periodWriteGuard.cjs
COPY packages/domain/partyPolicy.cjs ./packages/domain/partyPolicy.cjs

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3474 \
    ALLOW_TEST_TOKENS=false

USER node
EXPOSE 3474
CMD ["node", "apps/server/serve.cjs"]
