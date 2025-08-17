# Ignite Repo Manager Base - For repository management plugins (local, cloned, etc.)
FROM ignite/shared:latest

# Set working directory where the host directory will be mounted
WORKDIR /workspace

# Switch back to root to install repo management tools
USER root

# Install git and repository tools
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Ensure workspace directory exists with correct permissions
RUN mkdir -p /workspace && chown plugin:plugin /workspace

# Switch back to plugin user  
USER plugin

# Configure git for bind-mounted workspaces
RUN git config --global --add safe.directory /workspace

# Container starts in idle mode, waiting for repo manager plugin JS
CMD ["sleep", "infinity"]