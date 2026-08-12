FROM node:latest

RUN mkdir /XChainEncoder/
COPY ./package.json /XChainEncoder/package.json
COPY ./package-lock.json /XChainEncoder/package-lock.json
WORKDIR /XChainEncoder
RUN npm ci --omit=dev

COPY ./src /XChainEncoder/src
COPY ./docs /XChainEncoder/docs
# Glob pattern matches zero or one .env file so the build succeeds when
# the source has no .env (typical in CI / fresh clones). Mirrors the
# pattern used by xchain-indexer/Dockerfile.
COPY ./.en[v] /XChainEncoder/.env

# Run node directly rather than through `npm run api` (which is this exact
# command). npm builds a three-process tree, npm -> sh -c -> node, and neither
# wrapper forwards signals: measured on the regtest encoder, `docker stop` kills
# npm, node is never told anything and dies with the container, so its SIGTERM
# handler never runs and the instance lockfile survives into the next boot.
# Exec form, no shell, so node is PID 1 and gets the signal itself.
CMD ["node", "./src/api.js"]