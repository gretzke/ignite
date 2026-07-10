# deploy-repo fixture

A minimal foundry repo with a real, pre-baked artifact so the deploy-run
integration suite exercises the genuine freeze path (`ArtifactFreezeService`
→ foundry plugin `getArtifactData`) without compiling at runtime.

`src/Token.sol` is a minimal but real ERC20 (name/symbol/supply constructor,
transfer/approve/transferFrom). `out/Token.sol/Token.json` is produced by
running `forge build` in this directory (solc 0.8.24, see foundry.toml) and
committed; regenerate it the same way after editing the source. The `cache/`
directory is intentionally absent.

The substantial constructor (storage writes + event) is deliberate: the
revert-path test under-provisions `gasLimit` far above the 21k intrinsic
floor but far below the real requirement, so the transaction is accepted,
mined, and fails out-of-gas — a genuine post-validation on-chain revert.
