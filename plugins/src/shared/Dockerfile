# Ignite Shared Base - Foundation for all plugin types
FROM node:22-slim

# Create non-root user for security
RUN groupadd -g 1001 plugin && \
    useradd -u 1001 -g plugin -m plugin

# Install common utilities needed by all plugins
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Create plugin directory with correct ownership
RUN mkdir -p /plugin && chown plugin:plugin /plugin

# Switch to plugin user
WORKDIR /plugin
USER plugin

# Container starts in idle mode, waiting for plugin JS to be copied and executed
CMD ["sleep", "infinity"]