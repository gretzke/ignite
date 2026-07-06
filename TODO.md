# TODO / Deferred Work

Tracking for work deliberately deferred out of the architecture migration (Phases 2–4).
Items here have no current consumer or were triaged as follow-ups; they are not bugs
blocking current functionality.

## Deferred features (no consumer yet)

- **Secret-scope permission dimension.** The trust model is `{ hostWrite, net }` booleans.
  When explorer/verifier plugins land (they receive a user's block-explorer API key), the
  grant needs a named-secret scope so the approval dialog can show "this plugin receives
  your Etherscan API key" and the runtime injects the secret only when granted. Touches
  `PermissionGrant`/`PluginPermissions`/`TrustEntry`, `NATIVE_GRANT`/`UNTRUSTED_GRANT`,
  `getGrant` reconstruction, the trust API schemas, `PermissionApprovalDialog`, and
  `PluginsTab`. Deferred until the first explorer/verifier plugin exists (building it now
  would be unused surface).
- **`frontend` plugin runtime class (browser).** For signer/wallet plugins (MetaMask,
  WalletConnect, hardware wallets) that must run in the browser, not a container. Arrives
  with the signer milestone. Today only `container` and `declarative` runtimes exist.
- **Third-party declarative plugin installs.** Declarative plugins are native/built-in only.
  Allowing third-party declarative installs needs a non-image install path (the current
  install backends all build a Docker image).
- **Version migration paths.** Migrate CLI/plugin state when new versions are detected.

## Jobs system (Phase 2 follow-ups)

- **Kill-on-cancel.** `cancelJob` only transitions state + discards the runner result; it does
  not kill the underlying container exec / git op. Post-cancel runner output also still
  appends log events to the already-terminal record.
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

## State / infrastructure

- **Atomic-write temp-file collisions.** `FileSystem.writeJsonFile` and `TrustManager.writeTrustFile`
  use a fixed `${path}.tmp`. Concurrent same-path writers can interleave, and a rename race can
  throw ENOENT for a write that previously silently succeeded. Use a unique suffix
  (`${path}.${pid}.${ts}.tmp`).
- **Core lint baseline.** `npm run lint` in `core/` has 13 pre-existing problems — 9 are `no-undef`
  errors for `setTimeout`/`clearTimeout`/`NodeJS` globals (finalizeImage, IsolatedBuilder,
  runCommand, TrustManager) from a missing env config in `eslint.config.mjs`. Fix the env globals so
  future "lint clean" claims are verifiable, and record the baseline.
- **id-vs-name test-fixture bug.** ~13 baseline test failures in `ProfileManager`/`FileSystem` tests
  stem from an id-vs-name fixture mismatch; fixing the fixture turns them green.
- **Error-helper coverage.** Extend the API error helpers for 403 / typed-400 responses and convert
  the remaining inline-IApiError-literal handler sites to use them.

## Plugin install / build

- **Surface plugin `getInfo` errors.** `finalizeImage.parsePluginMetadata` reports "missing id/type"
  when a plugin's `getInfo` returns `{ success:false, error }`; check `success===false` and surface
  `error.message` instead (two-line diagnostic win now that the parser understands envelopes).
- **IsolatedBuilder robustness.** `waitForSquidReady` polls a baked-in dir rather than a real listen
  check in one path; no post-restart ACL re-verification (mitigated: ACL written before restart).

## Frontend polish

- **RepoCard button nesting.** Pre-existing button-in-button DOM nesting (a11y warning) where Tooltip
  action buttons sit inside a clickable card button.
- **Cancelled-job toast copy.** Cancelled jobs currently render through the same "Failed" toast as real
  failures; give cancel a distinct branch when a cancel affordance ships in the UI.

## Plugin security (original)

- Ensure compiler containers can only access `/workspace` (largely addressed by Phase 3: workspace is a
  single bind mount, `:ro` unless `hostWrite`, and `RepoService.getFile` rejects symlink escapes; revisit
  if additional mounts are ever added).
