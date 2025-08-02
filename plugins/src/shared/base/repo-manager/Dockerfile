# Ignite Repo Manager Base - For repository management plugins (local, cloned, etc.)
FROM ignite/shared:latest

# Switch back to root to install repo management tools
USER root

# Install git and repository tools
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js utilities for file operations
RUN npm install -g fs-extra glob

# Switch back to plugin user  
USER plugin

# Container starts in idle mode, waiting for repo manager plugin JS
CMD ["sleep", "infinity"]