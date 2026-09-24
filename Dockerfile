# Pinned by digest to the node:22.23.2-bookworm image whose V8/ICU build
# matches xchain-vm's consensus runtime pin: the floating node:22-bookworm
# tag can advance to a Node patch that fails that check.
FROM node:22.23.2-bookworm@sha256:dd5847a04b0deee391fa145f1f4c6d214196668b6bcc7988ebed67249f226844

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
