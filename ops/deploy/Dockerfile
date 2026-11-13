FROM node:22-bookworm-slim

WORKDIR /opt/novda

COPY ops/deploy/package.json ops/deploy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY apps/server ./apps/server
COPY packages/contracts/keys/licensePublicKey.cjs ./packages/contracts/keys/licensePublicKey.cjs
COPY packages/contracts/ticketEntryIdentity.cjs ./packages/contracts/ticketEntryIdentity.cjs
COPY apps/webapps ./apps/webapps
COPY packages/assets/fonts ./packages/assets/fonts
COPY ops/deploy/migrateProduction.cjs ./ops/deploy/migrateProduction.cjs
COPY ops/deploy/importSqliteBaseline.cjs ./ops/deploy/importSqliteBaseline.cjs
COPY ops/deploy/verifyProductionDatabase.cjs ./ops/deploy/verifyProductionDatabase.cjs
COPY packages/domain/periodWriteGuard.cjs ./packages/domain/periodWriteGuard.cjs
COPY packages/domain/partyPolicy.cjs ./packages/domain/partyPolicy.cjs
COPY packages/domain/pattaSequence.cjs ./packages/domain/pattaSequence.cjs
COPY packages/domain/legacyPattaBatch.cjs ./packages/domain/legacyPattaBatch.cjs
COPY packages/domain/pattaFinishScope.cjs ./packages/domain/pattaFinishScope.cjs
COPY packages/domain/payrollReducer.cjs ./packages/domain/payrollReducer.cjs
COPY packages/domain/stajDebtLedger.cjs ./packages/domain/stajDebtLedger.cjs

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3474 \
    ALLOW_TEST_TOKENS=false

USER node
# Resolve the startup dependency graph before deploying; importing does not start the server.
RUN node -e "require('./apps/server/serve.cjs')"
EXPOSE 3474
CMD ["node", "apps/server/serve.cjs"]
