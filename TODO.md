Plugin security:

- ensure plugins cannot call localhost
- ensure plugins mounting repo volumes can only access the /workspace directory
- ensure plugins can only read files in the /workspace directory in local repos until trusted (except for native plugins)
