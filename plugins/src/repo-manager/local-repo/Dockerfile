# Local Repository Manager - Mounts and maintains local host directories
FROM ignite/shared-repo-manager:latest

# Set working directory where the host directory will be mounted
WORKDIR /workspace

# Switch back to root to setup directory permissions
USER root

# Ensure workspace directory exists with correct permissions
RUN mkdir -p /workspace && chown plugin:plugin /workspace

# Switch back to plugin user
USER plugin

# Container starts in idle mode, maintaining the volume mount
# The actual plugin JS will be injected by the CLI
CMD ["sleep", "infinity"]