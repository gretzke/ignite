# IDEAS

Longer-horizon ideas captured during design sessions. Not commitments — each
needs its own design pass before scheduling. Distinct from TODO.md (which
tracks concrete follow-ups to shipped work).

## Vault key-management plugin surfaces (captured 2026-07-09, D2 design session)

Today the vault master key lives in the macOS Keychain with a `0600` file
fallback on Windows/Linux (`core/src/plugins/vault/masterKey.ts`). The idea:
generalize vault security into plugin surfaces instead of hardcoding backends.
It splits into two distinct primitives:

### 1. Master-key providers (unlock backends)

A plugin surface that supplies/derives the vault master key at session start.
Candidates:

- **OS keychain backends** — Windows Credential Manager (DPAPI), Linux Secret
  Service (libsecret) — same pattern as the existing macOS `security` CLI
  integration.
- **Passkey / Touch ID** — derive or release the master key via WebAuthn PRF /
  local biometric prompt.
- **Session password** — frontend authentication where the user enters a
  password once per session; the master key is derived (KDF) or decrypted with
  it and held in memory until the session ends.

Security caveat: a master-key provider sees the key that protects *every*
secret. Third-party plugins on this surface would need a distinct, stricter
trust tier than ordinary plugins (or first-party-only initially).

### 2. External secret resolvers (secret-reference backends)

Instead of storing ciphertext in Ignite's vault, a config field can hold a
*reference* into an external store; a resolver plugin fetches the plaintext at
injection time (secrets never persisted by Ignite at all):

- **1Password** — third-party plugin shelling out to `op` (host-side execution
  needed — containerized plugins can't reach host binaries today; wants a
  host-exec or native-runtime plugin class).
- **OS keyring entries** — resolve named keyring items.
- **Interactive decrypt** — password-prompt-per-use for user-encrypted blobs
  (needs a "plugin asks the user a question mid-operation" primitive; the
  wallet-approval wait from D2 is a cousin of this).

### Payoff: chainz key variants map onto these

The chainz signer (D2) supports only its `PrivateKey` variant. The deferred
variants each correspond to one of the primitives above:

- `EncryptedKey` → interactive-decrypt resolver (password prompt per session/use)
- `OnePassword` → 1Password external secret resolver
- `Keyring` → OS keyring resolver

So rather than chainz-specific hacks, the remaining variants become thin
mappings onto general key-management surfaces once those exist.
