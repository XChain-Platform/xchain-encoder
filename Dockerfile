# Pinned to node:22-bookworm, the tag .nvmrc and package.json engines already
# declare and the sibling service images already build on. `node:latest` floats:
# xchain-node rebuilds this image on every update (ModuleService.buildAndUp), so
# a routine rolling upgrade silently moves the runtime off the declared Node 22
# with no signal anywhere.
FROM node:22-bookworm

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

# Run node directly rather than through `npm run api` (which is this exact
# command). npm builds a three-process tree, npm -> sh -c -> node, and neither
# wrapper forwards signals: measured on the regtest encoder, `docker stop` kills
# npm, node is never told anything and dies with the container, so its SIGTERM
# handler never runs and the instance lockfile survives into the next boot.
# Exec form, no shell, so node is PID 1 and gets the signal itself.
CMD ["node", "./src/api.js"]