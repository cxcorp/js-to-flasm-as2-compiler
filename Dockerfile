FROM node:14-alpine

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json /app/
RUN npm ci

COPY . .

ENTRYPOINT ["node", "src/index.js"]