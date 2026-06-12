# Ignite Compiler Hardhat
FROM ignite/shared:latest

USER plugin

# Configure git to trust the workspace directory for the plugin user
RUN git config --global --add safe.directory /workspace && \
    git config --global --add safe.directory '*'

# Container starts in idle mode, waiting for compiler plugin JS
CMD ["sleep", "infinity"]
