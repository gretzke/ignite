# syntax=docker/dockerfile:1
# Build context must be the plugins/ directory so shared sources are available.
FROM node:22-trixie-slim AS build
WORKDIR /build
RUN npm install -g esbuild@0.25.8
COPY . /build/plugins
RUN esbuild /build/plugins/examples/stub-deployment-type/index.ts \
      --bundle --platform=node --format=cjs --target=node22 \
      --define:PLUGIN_VERSION='"0.0.1"' \
      --outfile=/plugin/index.js

FROM ignite/shared:latest
COPY --from=build /plugin/index.js /plugin/index.js
CMD ["sleep", "infinity"]
