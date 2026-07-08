FROM node:22-slim

WORKDIR /plugin

# No npm dependencies — the plugin only maps a config value onto per-chain
# URL strings, so there is nothing to install.
COPY index.cjs /plugin/index.js

# The container is kept idle; Ignite execs `node /plugin/index.js <op>`.
CMD ["sleep", "infinity"]
