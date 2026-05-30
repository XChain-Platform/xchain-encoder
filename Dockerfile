FROM node:latest

RUN mkdir /XChainEncoder/
COPY ./package.json /XChainEncoder/package.json
COPY ./package-lock.json /XChainEncoder/package-lock.json
WORKDIR /XChainEncoder
RUN npm ci --omit=dev

COPY ./src /XChainEncoder/src
# Glob pattern matches zero or one .env file so the build succeeds when
# the source has no .env (typical in CI / fresh clones). Mirrors the
# pattern used by xchain-indexer/Dockerfile.
COPY ./.en[v] /XChainEncoder/.env

CMD ["npm", "run", "api"]