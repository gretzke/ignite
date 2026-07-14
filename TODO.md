# MISC

- gas overrides per chain/contract
- upgradeable transparent/uups + initialization (alongside create/create2)
  - initialization on the proxy itself
- verifiers (initial ownership)
- ignite AI agents interacting with binary directly + mcp servers

# TODO / Deferred Work

Tracking for work deliberately deferred out of the architecture migration (Phases 2–4).
Items here have no current consumer or were triaged as follow-ups; they are not bugs
blocking current functionality.

## Deferred features (no consumer yet)

- **[RETIRED 2026-07-11: shipped as the D1b secrets dimension; D4 verifier plugins are the consumer.]** Secret-scope permission dimension. The trust model is `{ repoWrite, net }` booleans.
  When explorer/verifier plugins land (they receive a user's block-explorer API key), the
  grant needs a named-secret scope so the approval dialog can show "this plugin receives
  your Etherscan API key" and the runtime injects the secret only when granted. Touches
  `PermissionGrant`/`PluginPermissions`/`TrustEntry`, `NATIVE_GRANT`/`UNTRUSTED_GRANT`,
  `getGrant` reconstruction, the trust API schemas, `PermissionApprovalDialog`, and
  `PluginsTab`. Deferred until the first explorer/verifier plugin exists (building it now
  would be unused surface).
- **Plugin runtime classes (Phase 4 — NOT started).** There is no `runtime` field in
  `PluginMetadata` and no `PluginRuntime` dispatch interface yet; every plugin implicitly
  runs as a container, and `PluginType.REPO_MANAGER` still lingers in the type enum after
  the Phase 3 deletion. Phase 4 introduces `runtime: container | declarative` (then
  `frontend` with the signer milestone for MetaMask/WalletConnect/hardware wallets, which
  must run in the browser, not a container). Third-party declarative installs additionally
  need a non-image install path (the current install backends all build a Docker image).
- **Version migration paths.** Migrate CLI/plugin state when new versions are detected.

## Jobs system (Phase 2 follow-ups)

- **Third-party install job log streaming.** `PluginInstaller.install` has no output callback,
  so `plugin.install` jobs carry no live build logs (the compiler `onOutput` path does).
- **Reconnect 404 hardening.** If a tracked-active job was pruned server-side (newest-50 cap)
  or its file was corrupt at recovery, the reconnect `getJob` fetch 404s and re-toasts on every
  reconnect. Add a `jobMissing(jobId)` reducer to mark it terminal locally and stop retrying.
- **WS subscription cleanup + runtime job prune.** Server-side WS subscriptions are never
  released after a job goes terminal (client never sends `unsubscribe`), and the in-memory
  jobs map only prunes at startup — both O(session) growth. Add auto-teardown after a terminal
  event + a runtime prune.
- **`JobManager.recover()` fs-error resilience.** A `readdir`/`writeJsonFile` failure mid-recovery
  (other than per-file JSON corruption, which is handled) propagates out of startup. Wrap in
  try/catch → warn + start with an empty job set.
- **WS-event + HTTP-failure double-fault.** If a terminal WS event arrives but the follow-up
  `getJob` snapshot fetch fails, the view is left terminal-without-payload and unrouted (an error
  toast shows, but compile status stays stuck). Extend the reconnect diff to also re-fetch tracked
  terminal-but-unhandled views.
- **Immediacy test coverage.** No test uses a never-resolving runner to prove the handler replies
  `{jobId}` before the runner settles (currently guaranteed only by construction).
- **Job subscribe snapshot/live drop race.** Deployment-run subscriptions install their
  listener before the snapshot read and carry an epoch/high-water cursor. The older jobs
  subscription still reads its snapshot before installing the listener, so an event in that
  window can be lost. Port the D3 queue-and-flush ordering to jobs.

## Deployment follow-ups (D3)

- **Legacy-fee chain support.** D3 intentionally supports EIP-1559 only and blocks legacy
  fee markets during validation with `LEGACY_FEES_UNSUPPORTED`. Add typed legacy gas-price
  estimation/building before those chains can be selected for a run.
- **Command dedup is memory-only.** Exact `commandId` replays return current run state
  idempotently within a core session, but the consumed-command set does not survive a
  restart, so a replay after restart gets a 409 instead of the idempotent answer. A
  durable per-run command log would close this; low urgency (the frontend mints a fresh
  commandId per click and surfaces the 409).
- **Browser-wallet host affinity (Sol deep-dive, 2026-07-11).** Browser-wallet
  accounts are tab-local, but SignerRef carries no host identity and the
  bridge routes every request to the most recently registered tab — a stale
  or differently-stated tab can answer reads the plan was not built against.
  Design (sketched in the deep-dive): tabs register a runtimeInstanceId +
  bundle SHA-256; core excludes hash-mismatched hosts ("tab needs reload"
  state instead of wrong-format success), accounts carry an owner-host
  lease, and validation + sendTransaction route to the owning host. Also:
  per-wallet diagnostics from getAccounts (locked/deauthorized/threw ≠
  aggregate 'ok'), accountsChanged listener → UI invalidation, request
  generation ids in the signers slice, stale-selection marking in the
  wizard.
- **Artifact write failures are silent at lane-terminal time.** The on-disk artifact is
  best-effort at terminal transitions; a write failure (disk full) is not represented on
  the run. Mitigated: `GET /deployments/runs/:id/artifact` re-renders from the run record
  on demand, so the document is always recoverable.

## State / infrastructure

- **Core lint baseline.** Fixed 2026-07-06: Node runtime globals added to `eslint.config.mjs`;
  `npm run lint` in `core/` is now 0 errors / 5 warnings (`security/detect-child-process` +
  `no-explicit-any` warns, all deliberate).
- **Error-helper coverage.** Extend the API error helpers for 403 / typed-400 responses and convert
  the remaining inline-IApiError-literal handler sites to use them.

## Plugin install / build

- **IsolatedBuilder robustness.** `waitForSquidReady` polls a baked-in dir rather than a real listen
  check in one path; no post-restart ACL re-verification (mitigated: ACL written before restart).

## Repo lifecycle follow-ups (server-driven pipeline, 2026-07-06)

- **`clean` plugin op.** The clean/clean-compile buttons still use the pre-lifecycle
  endpoints; a true `forge clean`/hardhat-clean plugin operation (and wiring it as a
  lifecycle mode) is a small follow-up.
- **Failed add-repo registry residue.** If the add-mode pipeline fails (e.g. compile
  error), the repo stays registered with no frameworks; the card shows the failure but
  there is no automatic retry — a "retry setup" affordance would re-run the add pipeline.
- **fs-watch trigger.** Drift detection is focus-triggered only (cheap stat walks);
  filesystem watching was deliberately deferred.

## Frontend polish

- **RepoCard button nesting.** Pre-existing button-in-button DOM nesting (a11y warning) where Tooltip
  action buttons sit inside a clickable card button.
- **Cancelled-job toast copy.** Cancelled jobs currently render through the same "Failed" toast as real
  failures; give cancel a distinct branch when a cancel affordance ships in the UI.

## Plugin security (original)

- Ensure compiler containers can only access `/workspace` (largely addressed by Phase 3: workspace is a
  single bind mount, `:ro` unless `repoWrite`, and `RepoService.getFile` rejects symlink escapes; revisit
  if additional mounts are ever added).

## Chains & RPC store follow-ups (D1a final review, 2026-07-07)

- **Coded-error/UX cleanup batch.** `codedError(code,msg)` helper to replace 5x
  `Object.assign(new Error...)`; align `sendCodedOrCaught` with `sendCaughtError`
  field conventions (+`details`) so coded errors get specific toast titles;
  friendlier JSON-RPC error text ("RPC error undefined: undefined"); dedicated
  `rpcOpFailed` no-op instead of `fetchChainsFailed()` on RPC paths; RPC URL
  normalization (trailing-slash dupes); ChainModal edit preserves unedited
  API-set fields (shortName/rpc/infoURL); aria-labels on chains search + RPC add
  inputs; refetch-after-mutation drops active search query; offline cold-start
  empty state says "chainlist unavailable", not "no matches".
- **Chains test gaps.** Concurrent single-flight refresh test; RpcStore
  remove-non-preferred no-reassignment test.
- **Chainlist hardening.** Size cap on the chainid.network response
  (unbounded body today; localhost-only impact). SSRF note: checkRpc/verifyRpc
  deliberately fetch arbitrary URLs incl. private IPs (local anvil is a primary
  use case; API is localhost+token-gated) — accepted design, consider
  `redirect: 'manual'` when revisiting.

## Plugin config/vault follow-ups (D1b final review, 2026-07-08)

- **Master-key split-brain (darwin).** Transient keychain failure with no vault.key
  mints a fresh file key; secrets written in that window decrypt-fail (silently,
  fail-closed) once the keychain recovers. Consider refusing to create a file key
  when vault.json already has entries, and surfacing decrypt-fail distinctly from
  absent.
- **Config form polish.** Number field cleared→Save stores 0 (should unset via
  deleteConfigValue); no unset affordance for global non-secret values; no
  ConfirmDialog on secret-clear / override-remove; dead config?.fields fallback.
- **`required` config fields are declared but never enforced** (form or exec time).
- **Value-type validation on PUT config** (boolean into number field, select value
  not checked against options) — robustness only, user-initiated.
- **Store write serialization.** Vault/config stores are instantiated per consumer
  (API/executor/installer); temp+rename prevents corruption but concurrent RMW can
  resurrect entries. Shared singleton or per-file mutex. Widened by D2a list-item
  CRUD (2026-07-09 review): two concurrent list-item adds can drop one item from
  the config JSON while its secret stays orphaned in the vault (visible via
  secretsPresent); the fix should also reconcile orphaned `field.item.subkey`
  vault entries against the stored item list.
- **Surface newly-declared secret fields on plugin update** like newPermissions
  (installer TODO).
- **Cross-platform master-key backends** (raised 2026-07-09, D2 design — real
  signing keys now live in the vault). macOS has the Keychain; Windows/Linux
  fall back to a plain `0600` file at `~/.ignite/plugins/vault.key`, so the
  key sits next to the lock. Add Windows Credential Manager (DPAPI) and Linux
  Secret Service (libsecret) backends, same pattern as the `security` CLI
  integration in `masterKey.ts`. Longer-horizon generalization: IDEAS.md
  "Vault key-management plugin surfaces".

## RPC provider follow-ups (D1c, 2026-07-08)

- **File-picker config field type for chainz.** Pasting the config JSON into a
  secret string field is the v1 bridge; a file-picker field type would let the
  plugin read the host config file directly.
- **Provider staleness/error surfacing in UI.** A broken/slow provider silently
  degrades to an empty (cached) result; the chain RPC modal should be able to
  show "provider errored/stale" instead of just omitting the section.
- **Content-derived synthetic endpoint ids.** Ids are positional
  (`plugin:<id>:<chainId>:<n>`), so a refresh that reorders entries can
  misattach stale verification checks to the wrong row; derive ids from entry
  content (url hash) instead.
- **ProviderHealthChip wrong-chain distinction.** Per-row verify shows a
  generic error for a URL that answers with the wrong chainId; distinguish
  "reachable but wrong chain" from "unreachable".
- **Ecosystem plugin spin-out** — DONE for repos (2026-07-08): chainz moved to
  ../ignite-chainz-plugin (initial commit, unpushed); Infura/Alchemy became
  builtins. Remaining D7 work: publish the chainz repo + install-from-URL
  hardening.
- **Sanitize parsePluginOutput error quoting globally** — parse errors embed the full
  framed payload / stdout tail in error messages; any log sink that prints plugin
  error messages verbatim can leak config secrets (D1b-wide concern; RpcProviderService
  now sanitizes locally).
- **Invalidate provider cache on plugin install/uninstall/update** (currently only
  config/trust changes invalidate; reinstall-within-TTL serves stale entries).
- **listRpcs provider fan-out uses Promise.all** — one hung provider on cold cache
  delays the response up to 30s; switch to allSettled/stale-serve with staleness
  surfacing.
- **refresh query param z.coerce.boolean footgun** — ?refresh=false coerces true;
  frontend works around it; consider an explicit enum transform.
- **Chain icons load from icons.llamao.fi** — external CDN; offline falls back to
  the letter tile; consider core-side caching later.
- **Update-flow scope re-prompt asymmetry.** plugin.update only prompts on new
  boolean permissions; newly-declared secret/file scopes on update do not
  re-prompt the way installs now do (jobsEffects update branch).

## Plugin-platform genericity (special-casing audit, 2026-07-09)

**[ALL RETIRED 2026-07-13: shipped in D5.]** Items 1-3 landed as
manifest-declared `operations` + generic `POST /plugins/:id/operations/:op`
dispatch, `operationPermissions` hints unioned with host minimums, and the
`repoRead` capability with read-normalization; item 4 was removed earlier
(6197ed5).

## Signer surface follow-ups (D2a, 2026-07-09)

- **Builtin bundle injection via argv won't scale.** Builtin plugins run as
  `node --input-type=module -e <bundle>` — the whole bundle is a docker exec
  argv. The viem-heavy signer bundles needed minification to stay comfortably
  under the argv ceiling (77-95 KB today vs ~1 MB limit). A future heavier
  builtin (WalletConnect, Safe SDK) will blow this. Alternatives: pipe the
  bundle over stdin alongside options, or bake builtin bundles into the shared
  image at plugins-build time.
- **`--input-type=module` discovery.** Bare `node -e` only worked while
  builtin bundles happened to contain no residual ESM syntax; now it's
  explicit. If a builtin ever needs CJS interop, revisit per-plugin.
- **Full-run Docker integration flake widened** (2026-07-09, D2b). The
  documented contention mode (vitest.config.ts comment: Docker suites flake
  in full runs, never isolated) now hits `thirdparty-plugin` /
  `rpcProviderEndpoints` occasionally — the integration project runs
  sequentially but CONCURRENTLY with the parallel unit project, and the two
  new Docker suites (signer send, frontend runtime send) lengthen the
  contention window. `npx vitest run --project integration` alone is 12/12
  green. Fix direction: order the projects (unit first, then integration)
  instead of running them side by side.
- **Frontend-runtime bridge edge cases** (2026-07-09, D2b final review,
  accepted as minors). (1) A tab that disconnects between the `hasHost`
  check and the bridge request surfaces provider state `error` ("Provider
  returned an error") instead of `needs-browser` — cosmetic, tiny race
  window. (2) `registerHost` re-registration with a narrower pluginIds set
  leaves pending requests for the dropped plugins waiting out their timeout
  instead of settling them immediately. (3) `GET /plugins/:id/bundle`
  resolves the asset via `types[0]` — fine while frontend builtins are
  single-type; revisit if a multi-type frontend plugin ever lands.

## Deployment follow-ups (D5, 2026-07-13)

- **Bundled JS EVM simulation tier** (tevm/ethereumjs) — cut from D5 by steer
  (anvil container only); would give dependency-aware validation without
  Docker for RPCs lacking `eth_simulateV1`.
- **Deterministic-deployment-proxy deploy affordance.** CREATE2 preflight
  fails with CREATE2_PROXY_MISSING on chains without the canonical proxy; the
  presigned Arachnid tx + one-time deployer address are already constants in
  shared/api — an affordance could fund + broadcast it from the UI.
- **Job-mode generic plugin dispatch** (async + progress). prepareDeployment
  is synchronous with caps; a heavier deployment type (large search spaces)
  needs job semantics like compile.
- **Builtin argv ceiling:** `bundledInImage` machinery remains available for
  future builtins whose bundles exceed `MAX_ARG_STRLEN`; the hook deployer is
  now an external third-party plugin. Remaining: consider migrating future
  eligible builtins off argv injection for uniformity.
- **Anvil cannot simulate creation calls via eth_simulateV1** — tier 1 falls
  through to the fork tier on anvil by design; revisit if anvil gains create
  support (would speed up validation against local chains).
- **Tier-3 cross-contract conservatism**: any call after an earlier call is
  unestimable under per-tx estimates; deploys after calls remain estimable
  (constructors reading mutated state are an accepted residual of the
  labeled fallback tier).

## Verification follow-ups (D4)

- **Reconciliation with provider-plugin RPC bindings.** `verificationIntegration.ts`
  resolves the run's bound endpoint from the RpcStore only; runs whose binding was a
  provider-plugin endpoint fall back to `rawTx` parsing (container signers) or skip
  with a log line. Resolve provider endpoints the way validation does.
- **Bundle-store GC.** Content-addressed bundles under
  `profiles/<id>/deployments/bundles/` are never pruned (dedup keeps growth modest).
- **Debug-level raw plugin output.** Plugin stdout/stderr reach debug logs
  sentinel-stripped + control-stripped + capped (D1c posture); a plugin that prints
  its injected config leaks it to debug logs. Consider an opt-in flag for these lines.
- **ExplorerStore.overlays() id filter.** Uses a `:{chainId}:` substring match to
  scope derived-id overlays — correct today (plugin ids are colon-free) but fragile;
  overlays can also be created for unknown derived ids (inert garbage). Tighten to a
  structured id parse.
- **Etherscan zkSync-family exclusion list.** Static in the plugin; revisit when a
  zksolc-aware bundle exists (needs `zksolcVersion` capture).
