# Pinned to node:22-bookworm, the tag .nvmrc and package.json engines already
# declare and the sibling service images already build on. `node:latest` floats:
# xchain-node rebuilds this image on every update (ModuleService.buildAndUp), so
# a routine rolling upgrade silently moves the runtime off the declared Node 22
# with no signal anywhere.
FROM node:22-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir /XChainEncoder/
COPY ./package.json /XChainEncoder/package.json
COPY ./package-lock.json /XChainEncoder/package-lock.json
WORKDIR /XChainEncoder
RUN npm ci --omit=dev

COPY ./src /XChainEncoder/src
COPY ./docs /XChainEncoder/docs
# No .env is baked in: configuration reaches the container as environment
# (xchain-node at `docker run`, docker-compose.yml via env_file). An optional
# `COPY ./.en[v]` glob here builds only under BuildKit.

ENTRYPOINT ["tini", "--"]
CMD ["node", "./src/api.js"]
