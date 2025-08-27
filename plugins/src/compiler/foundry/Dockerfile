# Ignite Compiler Foundry
FROM ignite/shared:latest
# TODO: move to shared compiler base image

# Switch back to root to install compiler tools
USER root

# Install Foundry properly with explicit shell
RUN mkdir -p /root/.foundry && \
    curl -L https://foundry.paradigm.xyz | SHELL=/bin/bash bash && \
    /root/.foundry/bin/foundryup

# Make foundry binaries accessible to all users and copy to system location
RUN chmod -R 755 /root/.foundry/bin && \
    cp /root/.foundry/bin/* /usr/local/bin/ && \
    chmod +x /usr/local/bin/*

# Add foundry to PATH for all users  
ENV PATH="/usr/local/bin:/root/.foundry/bin:${PATH}"
RUN forge --version

# Switch back to plugin user
USER plugin

# Configure git to trust the workspace directory for the plugin user
RUN git config --global --add safe.directory /workspace && \
    git config --global --add safe.directory '*'

# Container starts in idle mode, waiting for compiler plugin JS
CMD ["sleep", "infinity"]