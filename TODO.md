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

## State / infrastructure

- **Core lint baseline.** Fixed 2026-07-06: Node runtime globals added to `eslint.config.mjs`;
  `npm run lint` in `core/` is now 0 errors / 5 warnings (`security/detect-child-process` +
  `no-explicit-any` warns, all deliberate).
- **Error-helper coverage.** Extend the API error helpers for 403 / typed-400 responses and convert
  the remaining inline-IApiError-literal handler sites to use them.

## Plugin install / build

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
