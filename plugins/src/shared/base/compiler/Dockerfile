# Ignite Compiler Foundry
FROM ignite/shared:latest

# Switch back to root to install compiler tools
USER root

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install Foundry properly with explicit shell
RUN mkdir -p /root/.foundry && \
    curl -L https://foundry.paradigm.xyz | SHELL=/bin/bash bash && \
    /root/.foundry/bin/foundryup

# Add foundry to PATH for all users  
ENV PATH="/root/.foundry/bin:${PATH}"
RUN forge --version

# Switch back to plugin user
USER plugin

# Container starts in idle mode, waiting for compiler plugin JS
CMD ["sleep", "infinity"]