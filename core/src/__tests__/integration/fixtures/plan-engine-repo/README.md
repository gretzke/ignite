# Plan-engine Foundry fixtures

These artifacts are committed so integration tests never compile at runtime.
Regenerate after changing a contract with:

```sh
docker run --rm -v "$PWD":/src -w /src ghcr.io/foundry-rs/foundry@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd 'forge build'
```
