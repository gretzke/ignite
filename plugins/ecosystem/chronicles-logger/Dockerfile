FROM node:22-slim AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY scripts/build.mjs ./scripts/build.mjs
RUN npm run build

FROM node:22-slim
WORKDIR /plugin
COPY --from=build /build/dist/index.js /plugin/index.js
CMD ["sleep", "infinity"]
