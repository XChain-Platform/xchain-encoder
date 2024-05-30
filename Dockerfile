FROM node:latest

RUN mkdir /XChainEncoder/
COPY ./package.json /XChainEncoder/package.json
WORKDIR /XChainEncoder
RUN npm install

COPY ./src /XChainEncoder/src
COPY ./.env /XChainEncoder/.env

CMD ["npm", "run", "api"]