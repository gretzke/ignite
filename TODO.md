- Fix toast progress bar on hover
- Add profile id to repo list to identify containers per profile
- Shutdown repo containers when they are not used
- Delete cloned repo container when repo is removed
- Copy error message when clicking an error toast

Plugin security:

- ensure plugins cannot call localhost
- ensure plugins mounting repo volumes can only access the /workspace directory
- ensure plugins can only read files in the /workspace directory in local repos until trusted (except for native plugins)
