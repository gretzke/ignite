// Host-side repository operations. Repositories are host data managed here —
// git runs directly on the host (hooks disabled, protocol allowlisted); repo
// content is never require()'d or eval'd. LOCAL repos: the host path IS the
// workspace. CLONED repos: workspace = <igniteHome>/repos/<profileId>/<dir>,
// a disposable clone with force-reset semantics (git is the source of truth,
// not user edits).
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import {
  parseGitHubUrl,
  normalizeRepoUrl,
  convertHttpsToSsh,
} from '@ignite/plugin-types';
import type { RepoInfoResult } from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { hashWorkspacePath } from '../utils/startup.js';
import { runCommand, type RunCommandResult } from '../utils/runCommand.js';
import { KeyedMutex } from '../utils/KeyedMutex.js';
import { redactUrlCredentials } from '../utils/redact.js';
import { getLogger } from '../utils/logger.js';
import { PinnedStore, pinnedOrigin } from './PinnedStore.js';

export enum RepoKind {
  LOCAL = 'local',
  CLONED = 'cloned',
}

// Ported from the now-deleted RepoContainerUtils.deriveRepoKind (Phase 3
// Task 4), with RepoContainerKind renamed to RepoKind.
export function deriveRepoKind(pathOrUrl: string): RepoKind {
  // Windows paths like C:\...
  if (/^[A-Za-z]:\\/.test(pathOrUrl)) return RepoKind.LOCAL;
  // Unix-like absolute or ~
  if (pathOrUrl.startsWith('/') || pathOrUrl.startsWith('~')) {
    return RepoKind.LOCAL;
  }
  // SSH-like git@host:owner/repo(.git)?
  if (/^git@[^:]+:.+/.test(pathOrUrl)) return RepoKind.CLONED;
  try {
    const u = new URL(pathOrUrl);
    if (u.protocol === 'file:') return RepoKind.LOCAL;
    if (['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) {
      return RepoKind.CLONED;
    }
  } catch {
    // Not a URL
  }
  // Fallback: if contains :// assume cloned, else local
  return pathOrUrl.includes('://') ? RepoKind.CLONED : RepoKind.LOCAL;
}

export interface RepoServiceDeps {
  fileSystem?: FileSystem;
  profiles?: ProfileManager;
  run?: typeof runCommand;
  materializationTimeoutMs?: number;
}
export interface PromotionSourceInspection {
  origin: string;
  commit: string;
  tags: string[];
  branch: string | null;
  dirty: boolean;
}

// Mirrors the old PluginResponse contract so handlers built on top of this
// service stay thin (map straight to IApiResponse/IApiError).
export type RepoResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

interface GitOutput {
  stdout: string;
  stderr: string;
}

// Core-internal writers (workflow saves and artifact copies) share one lock
// per canonical root. The lock deliberately covers caller-provided read/CAS
// sections too, so later API handlers can make read-compare-write atomic.
const repoWriteLocks = new Map<string, Promise<void>>();
export async function withRepoWriteLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoWriteLocks.get(root) ?? Promise.resolve();
  let release!: () => void;
  const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
  repoWriteLocks.set(root, tail);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (repoWriteLocks.get(root) === tail) repoWriteLocks.delete(root);
  }
}

// Host git safety rails (Global Constraints): hooks disabled so a malicious
// repo can't run code via post-checkout/post-merge etc; protocol allowlist so
// a host gitconfig with protocol.allow=always can't re-enable ext::/fd::
// transports (arbitrary command execution / fd inheritance).
const HOOKS_OFF = ['-c', 'core.hooksPath=/dev/null'];
const GIT_ALLOW_PROTOCOL = 'https:git:ssh:file';

// git stderr patterns that mean "the transport rejected us", not "the repo is
// broken". "Repository not found" is included deliberately: GitHub reports
// private repos as not-found to unauthenticated HTTPS clients, and resolving
// exactly that case is what the SSH fallback is for.
const GIT_AUTH_ERROR =
  /(could not read Username|could not read Password|Authentication failed|Permission denied|access denied|Invalid username or password|HTTP 40[13]|returned error: 40[13]|terminal prompts disabled|Repository not found)/i;

// Timeouts per the Shared design: clone is slow (network + full history of
// the default branch), fetch/pull touch the network but are bounded, local
// ops never leave disk.
const TIMEOUT_CLONE_MS = 10 * 60 * 1000;
const TIMEOUT_FETCH_MS = 2 * 60 * 1000;
const TIMEOUT_SUBMODULES_MS = 8 * 60 * 1000;
const TIMEOUT_LOCAL_MS = 30 * 1000;
export const PINNED_MATERIALIZATION_TIMEOUT_MS = 10 * 60 * 1000;

// Schemes git is allowed to clone. Anything else (notably ext:: and fd::,
// which can execute an arbitrary host command / inherit an arbitrary fd) is
// rejected before any git invocation. scp-like `git@host:path` is the fourth
// accepted form alongside the three URL schemes plus file://.
export function isAllowedCloneUrl(url: string): boolean {
  return (
    /^https:\/\//i.test(url) ||
    /^git:\/\//i.test(url) ||
    /^ssh:\/\//i.test(url) ||
    /^file:\/\//i.test(url) ||
    /^git@[^:]+:.+/.test(url)
  );
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Host-side replacement for the containerized repo-manager plugins. Every op
// mirrors the exact behavioral contract of plugins/src/repo-manager/{local,
// cloned}-repo (dirty guards, force-reset, origin/-prefix checkout, shallow
// clone + remote-heads fetch, upToDate via left-only rev-list, detached HEAD
// -> branch null). Credentials: none — the host's ambient environment
// (ssh-agent, credential helpers, netrc) is the whole story; this class never
// touches or stores any secret.
export class RepoService {
  private static instance: RepoService;

  private readonly fileSystem: FileSystem;
  private readonly injectedProfiles?: ProfileManager;
  private readonly run: typeof runCommand;
  // Serializes mutating ops per repo identity: two overlapping repo.init
  // jobs for the same URL must never clone/rm-rf the same directory
  // concurrently (the pre-Phase-3 KeyedMutex guarded the container-name
  // race; this is its host-side equivalent).
  private readonly locks = new KeyedMutex();
  private readonly pinnedStore: PinnedStore;
  private readonly materializationTimeoutMs: number;

  constructor(deps?: RepoServiceDeps) {
    this.fileSystem = deps?.fileSystem ?? FileSystem.getInstance();
    this.injectedProfiles = deps?.profiles;
    this.run = deps?.run ?? runCommand;
    this.pinnedStore = new PinnedStore(this.fileSystem);
    this.materializationTimeoutMs = deps?.materializationTimeoutMs ?? PINNED_MATERIALIZATION_TIMEOUT_MS;
  }

  // Lock key: canonical URL for cloned repos (so https/ssh forms of the same
  // repo serialize together), resolved path for local ones. Cross-profile
  // over-serialization of the same URL is deliberate — cheap and safe.
  private lockKey(pathOrUrl: string): string {
    return deriveRepoKind(pathOrUrl) === RepoKind.CLONED
      ? `cloned:${normalizeRepoUrl(pathOrUrl)}`
      : `local:${path.resolve(pathOrUrl)}`;
  }

  static getInstance(): RepoService {
    if (!RepoService.instance) {
      RepoService.instance = new RepoService();
    }
    return RepoService.instance;
  }

  // Materialize a collaborator-authored URL only after first-contact origin
  // approval. The worktree is intentionally detached and never participates
  // in ordinary branch/pull/reset operations.
  async ensurePinnedClone(profileId: string, url: string, commit: string): Promise<{ path: string }> {
    const origin = pinnedOrigin(url);
    if (!(await this.pinnedStore.isOriginApproved(profileId, url))) {
      throw Object.assign(new Error(`Pinned origin approval required: ${origin}`), { code: 'PINNED_ORIGIN_UNAPPROVED', origins: [origin] });
    }
    const worktree = this.pinnedStore.worktreePath(profileId, url, commit);
    return this.locks.run(`pinned:${worktree}`, async () => {
      const controller = new AbortController();
      const deadline = Date.now() + this.materializationTimeoutMs;
      const timer = setTimeout(() => controller.abort(Object.assign(new Error('Pinned repository materialization timed out'), { code: 'PINNED_MATERIALIZATION_TIMEOUT' })), this.materializationTimeoutMs);
      const budget = { signal: controller.signal, remaining: () => Math.max(0, deadline - Date.now()) };
      let temp: string | undefined;
      try {
        try {
          await this.assertPinnedIntegrity(worktree, commit, budget);
          await this.pinnedStore.upsert(profileId, { url, commit, lastUsedAt: new Date().toISOString() });
          return { path: worktree };
        } catch {
          if (controller.signal.aborted) throw controller.signal.reason;
          await fs.rm(worktree, { recursive: true, force: true });
        }
        const parent = path.dirname(worktree);
        temp = path.join(parent, `.${path.basename(worktree)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        await fs.mkdir(parent, { recursive: true });
        await fs.rm(temp, { recursive: true, force: true });
        await fs.mkdir(temp, { recursive: true });
        const git = (args: string[], cap: number) => this.runPinnedGit(temp!, args, cap, budget);
        const init = await git(['init'], TIMEOUT_LOCAL_MS); if (!init.success) throw Object.assign(new Error(init.error.message), { code: init.error.code });
        const remote = await git(['remote', 'add', 'origin', url], TIMEOUT_LOCAL_MS); if (!remote.success) throw Object.assign(new Error(remote.error.message), { code: remote.error.code });
        const shallow = await git(['fetch', '--depth', '1', 'origin', commit], TIMEOUT_FETCH_MS);
        // Fetch tags explicitly: a requested commit may be reachable only from
        // a tag and therefore absent from the remote's branch-head fetch.
        const fetched = shallow.success ? shallow : await git(['fetch', '--tags', 'origin'], TIMEOUT_FETCH_MS);
        if (!fetched.success) throw Object.assign(new Error(fetched.error.message), { code: fetched.error.code });
        const checkoutRef = shallow.success ? 'FETCH_HEAD' : commit;
        const checkout = await git(['checkout', '--detach', checkoutRef], TIMEOUT_LOCAL_MS);
        if (!checkout.success) throw Object.assign(new Error(checkout.error.message), { code: checkout.error.code });
        // Approved top-level origins own their checked-out submodule content;
        // per-submodule approval is intentionally not required. The transport
        // allowlist and protocol.file.allow=never remain mandatory here.
        const submodules = await git(['-c', 'protocol.file.allow=never', 'submodule', 'update', '--init', '--recursive', '--depth', '1'], TIMEOUT_SUBMODULES_MS);
        if (!submodules.success) throw Object.assign(new Error(submodules.error.message), { code: submodules.error.code });
        await this.assertPinnedIntegrity(temp, commit, budget);
        if (controller.signal.aborted) throw controller.signal.reason;
        await fs.rename(temp, worktree);
        temp = undefined;
        await this.pinnedStore.upsert(profileId, { url, commit, lastUsedAt: new Date().toISOString() });
        return { path: worktree };
      } finally {
        clearTimeout(timer);
        if (temp) await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // Build outputs are untracked by convention, so they are excluded. Tracked
  // source mutations are reset; a dirty submodule requires re-materializing
  // its parent because reset --hard cannot restore nested worktrees.
  async assertPinnedIntegrity(worktree: string, commit: string, budget?: { signal: AbortSignal; remaining: () => number }): Promise<void> {
    const head = await this.runPinnedGit(worktree, ['rev-parse', 'HEAD'], TIMEOUT_LOCAL_MS, budget);
    const status = await this.runPinnedGit(worktree, ['status', '--porcelain', '--untracked-files=no'], TIMEOUT_LOCAL_MS, budget);
    const submoduleStatus = await this.runPinnedGit(worktree, ['submodule', 'foreach', '--recursive', 'git status --porcelain'], TIMEOUT_LOCAL_MS, budget);
    if (!head.success)
      throw Object.assign(new Error(head.error.message), { code: head.error.code });
    if (!status.success)
      throw Object.assign(new Error(status.error.message), { code: status.error.code });
    if (!submoduleStatus.success)
      throw Object.assign(new Error(submoduleStatus.error.message), { code: submoduleStatus.error.code });
    const badHead = head.data.stdout.trim().toLowerCase() !== commit.toLowerCase();
    const badStatus = status.data.stdout.trim() !== '';
    const badSubmodule = submoduleStatus.data.stdout.trim() !== '';
    if (!badHead) {
      if (badSubmodule) throw Object.assign(new Error('Pinned submodule integrity violation requires re-materialization'), { code: 'PINNED_INTEGRITY_VIOLATION' });
      if (badStatus) {
        getLogger().warn(`Resetting tracked mutation in pinned worktree ${worktree}`);
        const reset = await this.runPinnedGit(worktree, ['reset', '--hard', commit], TIMEOUT_LOCAL_MS, budget);
        if (!reset.success) throw Object.assign(new Error(reset.error.message), { code: reset.error.code });
        const clean = await this.runPinnedGit(worktree, ['status', '--porcelain', '--untracked-files=no'], TIMEOUT_LOCAL_MS, budget);
        if (!clean.success) throw Object.assign(new Error(clean.error.message), { code: clean.error.code });
        if (clean.data.stdout.trim() !== '') throw Object.assign(new Error('Pinned worktree remained dirty after reset'), { code: 'PINNED_INTEGRITY_VIOLATION' });
      }
      return;
    }
    throw Object.assign(new Error('Pinned worktree HEAD does not match requested commit'), { code: 'PINNED_INTEGRITY_VIOLATION' });
  }

  private async runPinnedGit(cwd: string, args: string[], timeoutMs: number, budget?: { signal: AbortSignal; remaining: () => number }): Promise<RepoResult<GitOutput>> {
    if (budget && budget.remaining() <= 0 && !budget.signal.aborted)
      return { success: false, error: { code: 'GIT_COMMAND_FAILED', message: 'Pinned repository materialization timed out' } };
    return this.runGit(cwd, args, budget ? Math.max(1, Math.min(timeoutMs, budget.remaining())) : timeoutMs, budget?.signal, true);
  }

  // === Identity -> host workspace dir ===

  // LOCAL: pathOrUrl itself is the workspace. CLONED: a deterministic,
  // per-profile directory under <igniteHome>/repos/<profileId>, so the same
  // URL clones to the same place across restarts and different profiles
  // never share a clone.
  // profileId is explicit where the caller addresses a specific profile
  // (e.g. DELETE /profiles/:id/repos must remove THAT profile's clone, not
  // the active one); it defaults to the current profile for the common case.
  async resolveWorkspacePath(
    pathOrUrl: string,
    profileId?: string
  ): Promise<string> {
    const kind = deriveRepoKind(pathOrUrl);
    if (kind === RepoKind.LOCAL) {
      return pathOrUrl;
    }
    const resolvedProfileId = profileId ?? (await this.getProfileId());
    const reposPath = this.fileSystem.getReposPath(resolvedProfileId);
    return path.join(reposPath, this.clonedDirName(pathOrUrl));
  }

  private async getProfileId(): Promise<string> {
    const profiles =
      this.injectedProfiles ?? (await ProfileManager.getInstance());
    return profiles.getCurrentProfile();
  }

  // True when the repo's workspace exists and is usable: LOCAL -> the path
  // is a git repository; CLONED -> a complete clone is present. Used by the
  // repo list endpoint to report `initialized` without running any jobs.
  async hasWorkspace(pathOrUrl: string, profileId?: string): Promise<boolean> {
    try {
      const workspacePath = await this.resolveWorkspacePath(
        pathOrUrl,
        profileId
      );
      if (deriveRepoKind(pathOrUrl) === RepoKind.LOCAL) {
        return await this.isGitRepo(workspacePath);
      }
      return await this.hasCompleteClone(workspacePath);
    } catch {
      return false;
    }
  }

  // Like resolveWorkspacePath, but throws when the directory doesn't exist.
  // Callers that bind-mount the result MUST use this: Docker auto-creates a
  // missing host path as an empty (root-owned, on Linux) directory instead
  // of erroring, which both breaks the eventual clone (EACCES) and turns
  // "repo not initialized" into a baffling "no frameworks detected".
  async resolveExistingWorkspacePath(
    pathOrUrl: string,
    profileId?: string
  ): Promise<string> {
    const workspacePath = await this.resolveWorkspacePath(pathOrUrl, profileId);
    let stats;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: getReposPath-derived or the user's own local repo path
      stats = await fs.stat(workspacePath);
    } catch {
      throw new Error(
        deriveRepoKind(pathOrUrl) === RepoKind.CLONED
          ? `Repository has not been initialized (no clone at ${workspacePath}). Initialize it first.`
          : `Local repository path does not exist: ${workspacePath}`
      );
    }
    if (!stats.isDirectory()) {
      throw new Error(`Workspace path is not a directory: ${workspacePath}`);
    }
    return workspacePath;
  }

  // Sanitized <owner>-<repo>-<hash> directory name. normalizeRepoUrl folds
  // scp-like and HTTPS forms of the same GitHub/GitLab repo to one canonical
  // string first, so cloning the "same" repo via a different URL scheme
  // reuses the same workspace instead of creating a duplicate clone.
  private clonedDirName(pathOrUrl: string): string {
    const slug = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'repo';

    let owner = 'unknown';
    let repo = 'repo';
    const gh = parseGitHubUrl(pathOrUrl);
    if (gh) {
      owner = slug(gh.owner);
      repo = slug(gh.name);
    } else {
      const parts = this.extractPathSegments(pathOrUrl);
      if (parts.length >= 2) {
        owner = slug(parts[parts.length - 2]);
        repo = slug(parts[parts.length - 1]);
      } else if (parts.length === 1) {
        repo = slug(parts[0]);
      }
    }
    const hash = hashWorkspacePath(normalizeRepoUrl(pathOrUrl));
    return `${owner}-${repo}-${hash}`;
  }

  // Best-effort owner/repo path segments for non-GitHub URLs (self-hosted
  // GitLab/Gitea/etc, or scp-like git@host:owner/repo forms that don't parse
  // as a WHATWG URL).
  private extractPathSegments(pathOrUrl: string): string[] {
    try {
      const u = new URL(pathOrUrl);
      return u.pathname
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
    } catch {
      const afterColon = pathOrUrl.includes(':')
        ? (pathOrUrl.split(':').pop() as string)
        : pathOrUrl;
      return afterColon
        .replace(/\.git$/, '')
        .split('/')
        .filter(Boolean);
    }
  }

  // === Ops ===

  // LOCAL: ensure the host path is a git repo. CLONED: clone if missing,
  // idempotent when a complete clone is already present. Serialized per repo
  // identity — overlapping init jobs for the same URL run one at a time.
  //
  // Clone strategy: clone into a sibling temp dir and atomically rename into
  // place on success. The final workspace path therefore either doesn't
  // exist or holds a COMPLETE clone — a crash/kill mid-clone leaves only a
  // temp dir (swept on the next init), never a half-initialized workspace
  // that later ops would happily treat as ready.
  async init(
    pathOrUrl: string,
    opts?: { signal?: AbortSignal }
  ): Promise<RepoResult<null>> {
    return this.locks.run(this.lockKey(pathOrUrl), () =>
      this.initLocked(pathOrUrl, opts?.signal)
    );
  }

  private async initLocked(
    pathOrUrl: string,
    signal?: AbortSignal
  ): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const workspacePath = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const ensured = await this.ensureGitRepo(workspacePath);
        if (!ensured.success) return ensured;
        return { success: true, data: null };
      }

      // CLONED: validate the URL scheme before any git invocation.
      if (!isAllowedCloneUrl(pathOrUrl)) {
        return {
          success: false,
          error: {
            code: 'CLONE_FAILED',
            message:
              `Refusing to clone repository: unsupported URL scheme in '${redactUrlCredentials(pathOrUrl)}'. ` +
              'Only https://, git://, ssh://, file://, and git@host:path are allowed.',
          },
        };
      }

      if (await this.hasCompleteClone(workspacePath)) {
        // Already cloned — idempotent no-op, matches the old plugin.
        return { success: true, data: null };
      }

      // A directory that exists but fails the completeness check is a
      // pre-atomic-rename partial clone (or otherwise corrupt). It's a
      // disposable managed clone — wipe and re-clone. Safe under the lock.
      await fs
        .rm(workspacePath, { recursive: true, force: true })
        .catch(() => {});

      const parentDir = path.dirname(workspacePath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: workspacePath is derived from FileSystem.getReposPath(profileId), not user input
      await fs.mkdir(parentDir, { recursive: true });
      await this.sweepStaleTempClones(parentDir, path.basename(workspacePath));

      const cloned = await this.cloneWithSshFallback(
        pathOrUrl,
        parentDir,
        path.basename(workspacePath),
        signal
      );
      if (!cloned.success) return cloned;
      const tempDir = cloned.data;

      // Atomic publish: same parent dir, so rename cannot cross filesystems.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: both paths derived from getReposPath
      await fs.rename(tempDir, workspacePath);

      // Fetch the full set of remote heads so non-default branches show up in
      // getBranches. Best-effort and NOT gated: a transient network blip
      // after a successful clone must not fail init (a retry short-circuits
      // on the complete clone and would never re-fetch). A later
      // getBranches/checkout re-runs `fetch --all` and recovers.
      const fetchHeads = await this.runNetworkGit(
        workspacePath,
        ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
        RepoKind.CLONED,
        signal
      );
      if (!fetchHeads.success) {
        getLogger().warn(
          `Cloned ${redactUrlCredentials(pathOrUrl)} but failed to fetch all remote heads (non-default branches may be missing until the next fetch): ${fetchHeads.error.message}`
        );
      }

      return { success: true, data: null };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INIT_ERROR',
          message: redactUrlCredentials(errMsg(error)),
        },
      };
    }
  }

  // A complete clone has a resolvable HEAD; `git clone` only publishes one
  // after objects + checkout finish, and our own temp-dir+rename flow only
  // publishes complete clones. Catches partial clones left by pre-fix
  // versions (or a corrupted .git).
  private async hasCompleteClone(workspacePath: string): Promise<boolean> {
    if (!(await this.isGitRepo(workspacePath))) return false;
    const head = await this.runGit(
      workspacePath,
      ['rev-parse', '--verify', 'HEAD'],
      TIMEOUT_LOCAL_MS
    );
    return head.success;
  }

  // Clone into a fresh temp dir; on an auth-shaped HTTPS failure, retry once
  // with the SSH form of the URL (the host's ssh-agent/keys often work where
  // no HTTPS credential helper is configured — the old GitCredentialManager
  // provided exactly this fallback). The surviving remote URL is whichever
  // transport worked, so every later fetch/pull uses it automatically.
  // Returns the temp dir containing the finished clone.
  private async cloneWithSshFallback(
    pathOrUrl: string,
    parentDir: string,
    dirName: string,
    signal?: AbortSignal
  ): Promise<RepoResult<string>> {
    const cloneInto = async (url: string): Promise<RepoResult<string>> => {
      const tempDir = path.join(
        parentDir,
        `.tmp-${dirName}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
      );
      const clone = await this.runGit(
        parentDir,
        [
          'clone',
          '--depth',
          '1',
          '--recurse-submodules',
          '--shallow-submodules',
          url,
          tempDir,
        ],
        TIMEOUT_CLONE_MS,
        signal
      );
      if (!clone.success) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        return clone;
      }
      return { success: true, data: tempDir };
    };

    const first = await cloneInto(pathOrUrl);
    if (first.success) return first;

    const sshUrl = convertHttpsToSsh(pathOrUrl);
    const authShaped = GIT_AUTH_ERROR.test(first.error.message);
    if (!authShaped || sshUrl === pathOrUrl || signal?.aborted) {
      return {
        success: false,
        error: {
          code: 'CLONE_FAILED',
          message: `Failed to clone repository: ${first.error.message}`,
        },
      };
    }

    getLogger().info(
      `HTTPS clone of ${redactUrlCredentials(pathOrUrl)} was rejected (auth); retrying over SSH as ${sshUrl}`
    );
    const second = await cloneInto(sshUrl);
    if (second.success) return second;
    return {
      success: false,
      error: {
        code: 'CLONE_FAILED',
        message:
          `Failed to clone repository over HTTPS (${first.error.message}) ` +
          `and the SSH fallback also failed (${second.error.message})`,
      },
    };
  }

  // Remove leftover temp clones for this workspace dir (a previous core
  // process died mid-clone). Only .tmp-<dirName>-* siblings are touched.
  private async sweepStaleTempClones(
    parentDir: string,
    dirName: string
  ): Promise<void> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: parentDir is getReposPath-derived
      const entries = await fs.readdir(parentDir);
      const prefix = `.tmp-${dirName}-`;
      await Promise.all(
        entries
          .filter((name) => name.startsWith(prefix))
          .map((name) =>
            fs
              .rm(path.join(parentDir, name), { recursive: true, force: true })
              .catch(() => {})
          )
      );
    } catch {
      // Best-effort.
    }
  }

  async getBranches(
    pathOrUrl: string
  ): Promise<RepoResult<{ branches: string[] }>> {
    try {
      const cwd = await this.resolveWorkspacePath(pathOrUrl);
      const ensured = await this.ensureGitRepo(cwd);
      if (!ensured.success) return ensured;
      const refs = await this.listAllRefs(cwd);
      if (!refs.success) return refs;
      return { success: true, data: { branches: refs.data } };
    } catch (error) {
      return {
        success: false,
        error: { code: 'GET_BRANCHES_ERROR', message: errMsg(error) },
      };
    }
  }

  async checkoutBranch(
    pathOrUrl: string,
    branch: string
  ): Promise<RepoResult<null>> {
    if (this.isPinnedWorktree(pathOrUrl)) return this.pinnedReadOnlyResult();
    return this.locks.run(this.lockKey(pathOrUrl), () =>
      this.checkoutBranchLocked(pathOrUrl, branch)
    );
  }

  private async checkoutBranchLocked(
    pathOrUrl: string,
    branch: string
  ): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const clean = await this.ensureCleanRepo(cwd);
        if (!clean.success) return clean;
      } else {
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
      }

      const fetchRes = await this.runNetworkGit(
        cwd,
        ['fetch', '--all', '--prune'],
        kind
      );
      if (!fetchRes.success) return fetchRes;

      if (kind === RepoKind.CLONED) {
        const reset = await this.hardReset(cwd);
        if (!reset.success) return reset;
      }

      const co = await this.doCheckoutBranch(cwd, branch);
      if (!co.success) return co;

      return { success: true, data: null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'CHECKOUT_BRANCH_ERROR', message: errMsg(error) },
      };
    }
  }

  // Shared origin/-prefix handling: checking out "origin/foo" creates (or
  // reuses) a local tracking branch "foo" rather than leaving HEAD detached.
  private async doCheckoutBranch(
    cwd: string,
    branch: string
  ): Promise<RepoResult<null>> {
    if (branch.startsWith('origin/')) {
      const localBranchName = branch.replace('origin/', '');
      const branchExists = await this.runGit(
        cwd,
        ['show-ref', '--verify', '--quiet', `refs/heads/${localBranchName}`],
        TIMEOUT_LOCAL_MS
      );
      if (branchExists.success) {
        const co = await this.runGit(
          cwd,
          ['checkout', localBranchName],
          TIMEOUT_LOCAL_MS
        );
        if (!co.success) return co;
      } else {
        const co = await this.runGit(
          cwd,
          ['checkout', '-b', localBranchName, branch],
          TIMEOUT_LOCAL_MS
        );
        if (!co.success) return co;
      }
    } else {
      const co = await this.runGit(cwd, ['checkout', branch], TIMEOUT_LOCAL_MS);
      if (!co.success) return co;
    }
    return { success: true, data: null };
  }

  async checkoutCommit(
    pathOrUrl: string,
    commit: string
  ): Promise<RepoResult<null>> {
    if (this.isPinnedWorktree(pathOrUrl)) return this.pinnedReadOnlyResult();
    return this.locks.run(this.lockKey(pathOrUrl), () =>
      this.checkoutCommitLocked(pathOrUrl, commit)
    );
  }

  private async checkoutCommitLocked(
    pathOrUrl: string,
    commit: string
  ): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const clean = await this.ensureCleanRepo(cwd);
        if (!clean.success) return clean;
      } else {
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
      }

      const fetchRes = await this.runNetworkGit(
        cwd,
        ['fetch', '--all', '--prune'],
        kind
      );
      if (!fetchRes.success) return fetchRes;

      if (kind === RepoKind.CLONED) {
        const reset = await this.hardReset(cwd);
        if (!reset.success) return reset;
      }

      const co = await this.runGit(
        cwd,
        ['checkout', '--detach', commit],
        TIMEOUT_LOCAL_MS
      );
      if (!co.success) return co;

      return { success: true, data: null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'CHECKOUT_COMMIT_ERROR', message: errMsg(error) },
      };
    }
  }

  async pullChanges(pathOrUrl: string): Promise<RepoResult<null>> {
    if (this.isPinnedWorktree(pathOrUrl)) return this.pinnedReadOnlyResult();
    return this.locks.run(this.lockKey(pathOrUrl), () =>
      this.pullChangesLocked(pathOrUrl)
    );
  }

  private async pullChangesLocked(
    pathOrUrl: string
  ): Promise<RepoResult<null>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      if (kind === RepoKind.LOCAL) {
        const clean = await this.ensureCleanRepo(cwd);
        if (!clean.success) return clean;
      } else {
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
        // Cloned repos are managed clones with no user work to preserve, but
        // operations like compilation leave untracked byproducts behind
        // (e.g. foundry.lock) that make `git pull` abort when the incoming
        // commits touch the same paths. Force a pristine tree before pulling.
        const pristine = await this.makePristine(cwd);
        if (!pristine.success) return pristine;
      }

      const pull = await this.runNetworkGit(cwd, ['pull', '--ff-only'], kind);
      if (!pull.success) return pull;

      return { success: true, data: null };
    } catch (error) {
      return {
        success: false,
        error: { code: 'PULL_ERROR', message: errMsg(error) },
      };
    }
  }

  // Destructive by design (frontend confirms before calling): discard
  // uncommitted changes and remove untracked files. Identical for both kinds.
  async reset(pathOrUrl: string): Promise<RepoResult<null>> {
    if (this.isPinnedWorktree(pathOrUrl)) return this.pinnedReadOnlyResult();
    return this.locks.run(this.lockKey(pathOrUrl), async () => {
      try {
        const cwd = await this.resolveWorkspacePath(pathOrUrl);
        const ensured = await this.ensureGitRepo(cwd);
        if (!ensured.success) return ensured;
        return await this.makePristine(cwd);
      } catch (error) {
        return {
          success: false as const,
          error: { code: 'RESET_ERROR', message: errMsg(error) },
        };
      }
    });
  }

  private isPinnedWorktree(pathOrUrl: string): boolean {
    if (!path.isAbsolute(pathOrUrl)) return false;
    const profileId = this.injectedProfiles?.getCurrentProfile();
    if (!profileId) return false;
    const root = path.resolve(this.fileSystem.getReposPath(profileId), 'pinned');
    const candidate = path.resolve(pathOrUrl);
    return candidate === root || candidate.startsWith(root + path.sep);
  }

  private pinnedReadOnlyResult(): RepoResult<null> {
    return { success: false, error: { code: 'PINNED_REPO_READ_ONLY', message: 'Pinned worktrees are read-only; materialize another pin instead.' } };
  }

  async getRepoInfo(pathOrUrl: string): Promise<RepoResult<RepoInfoResult>> {
    try {
      const kind = deriveRepoKind(pathOrUrl);
      const cwd = await this.resolveWorkspacePath(pathOrUrl);

      const ensured = await this.ensureGitRepo(cwd);
      if (!ensured.success) return ensured;

      const branch = await this.getCurrentBranch(cwd);
      if (!branch.success) return branch;
      const commit = await this.getCurrentCommit(cwd);
      if (!commit.success) return commit;

      // Cloned repos are never dirty — every mutating op force-resets them.
      let dirty = false;
      if (kind === RepoKind.LOCAL) {
        const status = await this.hasTrackedChanges(cwd);
        if (!status.success) return status;
        dirty = status.data;
      }

      const upToDate = await this.isUpToDateWithRemote(cwd, kind);
      if (!upToDate.success) return upToDate;

      return {
        success: true,
        data: {
          branch: branch.data,
          commit: commit.data,
          dirty,
          upToDate: upToDate.data,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INFO_ERROR', message: errMsg(error) },
      };
    }
  }

  /** Read-only git facts used by workflow-promotion preview/apply. */
  async inspectPromotionSource(pathOrUrl: string): Promise<PromotionSourceInspection> {
    const cwd = await this.resolveExistingWorkspacePath(pathOrUrl);
    const ensured = await this.ensureGitRepo(cwd);
    if (!ensured.success) throw Object.assign(new Error(ensured.error.message), { code: ensured.error.code });
    const [origin, commit, tags, branch, status] = await Promise.all([
      this.runGit(cwd, ['remote', 'get-url', 'origin'], TIMEOUT_LOCAL_MS),
      this.runGit(cwd, ['rev-parse', 'HEAD'], TIMEOUT_LOCAL_MS),
      this.runGit(cwd, ['tag', '--points-at', 'HEAD'], TIMEOUT_LOCAL_MS),
      this.runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], TIMEOUT_LOCAL_MS),
      this.runGit(cwd, ['status', '--porcelain'], TIMEOUT_LOCAL_MS),
    ]);
    if (!origin.success || !origin.data.stdout.trim())
      throw Object.assign(new Error('origin remote is required for workflow promotion'), { code: 'PROMOTION_ORIGIN_REQUIRED' });
    if (!commit.success) throw Object.assign(new Error(commit.error.message), { code: commit.error.code });
    if (!tags.success) throw Object.assign(new Error(tags.error.message), { code: tags.error.code });
    if (!status.success) throw Object.assign(new Error(status.error.message), { code: status.error.code });
    return {
      origin: origin.data.stdout.trim(),
      commit: commit.data.stdout.trim(),
      tags: tags.data.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort(),
      branch: branch.success ? branch.data.stdout.trim() || null : null,
      dirty: status.data.stdout.trim().length > 0,
    };
  }

  async isExistingGitRepository(pathOrUrl: string): Promise<boolean> {
    try {
      const cwd = await this.resolveExistingWorkspacePath(pathOrUrl);
      const result = await this.runGit(cwd, ['rev-parse', '--is-inside-work-tree'], TIMEOUT_LOCAL_MS);
      return result.success && result.data.stdout.trim() === 'true';
    } catch { return false; }
  }

  async getFile(
    pathOrUrl: string,
    filePath: string
  ): Promise<RepoResult<{ content: string }>> {
    try {
      const validated = this.validateFilePath(filePath);
      if (!validated.success) return validated;

      const cwd = await this.resolveWorkspacePath(pathOrUrl);
      // path.join (not path.resolve) — an absolute-looking filePath must not
      // be able to override cwd the way path.resolve's right-to-left
      // semantics would (path.resolve(cwd, '/etc/passwd') === '/etc/passwd').
      const target = path.join(cwd, filePath);
      const resolvedRoot = path.resolve(cwd);
      const resolvedTarget = path.resolve(target);
      // Lexical containment: even though validateFilePath already rejects any
      // segment that could escape the root, re-derive containment from the
      // resolved absolute path before touching disk. Fast reject that runs
      // before any filesystem access.
      if (
        resolvedTarget !== resolvedRoot &&
        !resolvedTarget.startsWith(resolvedRoot + path.sep)
      ) {
        return {
          success: false,
          error: {
            code: 'INVALID_PATH',
            message: 'File path escapes repository root',
          },
        };
      }

      // Symlink-aware containment. Lexical checks and fs.stat/readFile follow
      // symlinks at the OS level, so a committed symlink (leaf OR an
      // intermediate path component) pointing outside the workspace would
      // otherwise leak arbitrary host files (~/.ssh/id_rsa, /etc/passwd, …).
      // For CLONED repos the working tree is fully attacker-controlled (any
      // public repo can commit such a symlink), and on the host this is the
      // ONLY containment jail — the old container jail is gone. Resolve BOTH
      // the root and the target to their real paths (the root too: on macOS
      // /tmp is itself a symlink to /private/tmp) and require the real target
      // to still live inside the real root. In-tree symlinks that resolve
      // back inside the workspace are allowed; anything escaping is refused
      // with SUSPICIOUS_PATH_PATTERN (an explicit containment refusal, NOT
      // FILE_NOT_FOUND — the file may well exist, we're declining to read it).
      let realRoot: string;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: resolvedRoot is FileSystem.getReposPath-derived or the LOCAL repo path
        realRoot = await fs.realpath(resolvedRoot);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return {
            success: false,
            error: {
              code: 'FILE_NOT_FOUND',
              message: `File not found: ${filePath}`,
            },
          };
        }
        throw error;
      }
      let realTarget: string;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: containment is enforced against realRoot immediately below, before any read
        realTarget = await fs.realpath(resolvedTarget);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return {
            success: false,
            error: {
              code: 'FILE_NOT_FOUND',
              message: `File not found: ${filePath}`,
            },
          };
        }
        throw error;
      }
      if (
        realTarget !== realRoot &&
        !realTarget.startsWith(realRoot + path.sep)
      ) {
        return {
          success: false,
          error: {
            code: 'SUSPICIOUS_PATH_PATTERN',
            message:
              'File path resolves outside the repository (symlink escape)',
          },
        };
      }

      let stats;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: realTarget containment is checked above
        stats = await fs.stat(realTarget);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          return {
            success: false,
            error: {
              code: 'FILE_NOT_FOUND',
              message: `File not found: ${filePath}`,
            },
          };
        }
        throw error;
      }
      if (!stats.isFile()) {
        return {
          success: false,
          error: {
            code: 'FILE_NOT_FOUND',
            message: `Path is not a file: ${filePath}`,
          },
        };
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Safe: realTarget containment is checked above
      const content = await fs.readFile(realTarget, 'utf8');
      return { success: true, data: { content } };
    } catch (error) {
      return {
        success: false,
        error: { code: 'FILE_READ_ERROR', message: errMsg(error) },
      };
    }
  }

  // Internal-only write counterpart to getFile. Both lexical and realpath
  // containment checks are needed: git worktrees can contain attacker-owned
  // symlinks, and parents must be verified again after mkdir before rename.
  async writeRepoFile(pathOrUrl: string, filePath: string, contents: string): Promise<RepoResult<null>> {
    const validated = this.validateFilePath(filePath);
    if (!validated.success) return validated;
    try {
      const root = await this.resolveExistingWorkspacePath(pathOrUrl);
      const realRoot = await fs.realpath(path.resolve(root));
      return await withRepoWriteLock(realRoot, () => this.writeRepoFileLocked(realRoot, filePath, contents));
    } catch (error) {
      return { success: false, error: { code: 'FILE_WRITE_ERROR', message: errMsg(error) } };
    }
  }

  // Transaction seam for workflow CAS: the callback owns the canonical-root
  // lock once, and its bound writer calls the unlocked body directly.
  async withWorkflowWriteLock<T>(
    pathOrUrl: string,
    fn: (files: {
      readFile: (relPath: string) => Promise<string | null>;
      writeFile: (relPath: string, contents: string) => Promise<void>;
    }) => Promise<T>
  ): Promise<T> {
    const root = await this.resolveExistingWorkspacePath(pathOrUrl);
    const realRoot = await fs.realpath(path.resolve(root));
    return withRepoWriteLock(realRoot, () => fn({
      readFile: async (relPath) => {
        const result = await this.getFile(realRoot, relPath);
        if (result.success) return result.data.content;
        if (result.error.code === 'FILE_NOT_FOUND') return null;
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      },
      writeFile: async (relPath, contents) => {
        const result = await this.writeRepoFileLocked(realRoot, relPath, contents);
        if (!result.success) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      },
    }));
  }

  private async writeRepoFileLocked(realRoot: string, filePath: string, contents: string): Promise<RepoResult<null>> {
    const validated = this.validateFilePath(filePath);
    if (!validated.success) return validated;
    try {
      const normalized = filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const target = path.resolve(realRoot, normalized);
      if (target === realRoot || !target.startsWith(realRoot + path.sep)) return { success: false, error: { code: 'INVALID_PATH', message: 'File path escapes repository root' } };
        // Walk every existing ancestor with lstat before creating anything.
        // Symlinked ancestors are rejected even when they happen to resolve
        // back inside the repository: creation and publication must stay on
        // the verified canonical directory chain.
        let realParent = realRoot;
        const parentSegments = normalized.split('/').slice(0, -1);
        for (const segment of parentSegments) {
          const candidate = path.join(realParent, segment);
          let stats: import('node:fs').Stats;
          try {
            stats = await fs.lstat(candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            try { await fs.mkdir(candidate); }
            catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
            stats = await fs.lstat(candidate);
          }
          if (stats.isSymbolicLink() || !stats.isDirectory())
            return { success: false, error: { code: 'SUSPICIOUS_PATH_PATTERN', message: 'File ancestors must be real directories' } };
          const canonical = await fs.realpath(candidate);
          if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep))
            return { success: false, error: { code: 'SUSPICIOUS_PATH_PATTERN', message: 'File parent resolves outside the repository' } };
          realParent = canonical;
        }
        const publishTarget = path.join(realParent, path.basename(target));
        let existing: import('node:fs').Stats | undefined;
        try { existing = await fs.lstat(publishTarget); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) return { success: false, error: { code: 'SUSPICIOUS_PATH_PATTERN', message: 'Write target must be a regular file or absent' } };
        const temp = path.join(realParent, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
        try {
          await fs.writeFile(temp, contents, 'utf8');
          await fs.rename(temp, publishTarget);
          return { success: true, data: null };
        } finally { await fs.rm(temp, { force: true }).catch(() => {}); }

    } catch (error) {
      return { success: false, error: { code: 'FILE_WRITE_ERROR', message: errMsg(error) } };
    }
  }

  // Ported from plugins/src/shared/base/repo-manager/index.ts (validateFilePath,
  // lines 236-271) verbatim in behavior: empty/`..`/dot-leading segments are
  // INVALID_PATH; a remaining ".."/"./" substring after the segment scan
  // (e.g. a single segment literally named "a..b") is SUSPICIOUS_PATH_PATTERN.
  private validateFilePath(filePath: string): RepoResult<true> {
    const normalizedPath = filePath
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const pathSegments = normalizedPath.split('/');

    for (const segment of pathSegments) {
      if (segment === '' || segment === '..' || segment.startsWith('.')) {
        return {
          success: false,
          error: {
            code: 'INVALID_PATH',
            message: `File path contains invalid segments: ${segment}`,
          },
        };
      }
    }

    if (normalizedPath.includes('..') || normalizedPath.includes('./')) {
      return {
        success: false,
        error: {
          code: 'SUSPICIOUS_PATH_PATTERN',
          message: 'File path contains suspicious patterns',
        },
      };
    }

    return { success: true, data: true };
  }

  // rm -rf the cloned workspace dir; LOCAL is a no-op (the host path is the
  // user's own repo, never ours to delete). Best-effort: mirrors the old
  // removeRepoContainers cleanup, which never blocks repo removal.
  // profileId must be the profile whose registry entry is being removed —
  // resolving via the CURRENT profile would delete the wrong profile's clone
  // when a non-active profile's repo is removed.
  async removeClone(pathOrUrl: string, profileId?: string): Promise<void> {
    const kind = deriveRepoKind(pathOrUrl);
    if (kind === RepoKind.LOCAL) return;
    await this.locks.run(this.lockKey(pathOrUrl), async () => {
      try {
        const workspacePath = await this.resolveWorkspacePath(
          pathOrUrl,
          profileId
        );
        await fs.rm(workspacePath, { recursive: true, force: true });
      } catch {
        // Best-effort; failure to clean up disk must not block the caller.
      }
    });
  }

  // === Git primitives (ported from plugins/src/shared/utils/git.ts,
  // parameterized on cwd instead of a fixed /workspace) ===

  private async isGitRepo(cwd: string): Promise<boolean> {
    const r = await this.runGit(
      cwd,
      ['rev-parse', '--is-inside-work-tree'],
      TIMEOUT_LOCAL_MS
    );
    return r.success;
  }

  private async ensureGitRepo(cwd: string): Promise<RepoResult<true>> {
    if (!(await this.isGitRepo(cwd))) {
      return {
        success: false,
        error: {
          code: 'NOT_GIT_REPO',
          message: `Not a git repository at ${cwd}`,
        },
      };
    }
    return { success: true, data: true };
  }

  private async hasTrackedChanges(cwd: string): Promise<RepoResult<boolean>> {
    const res = await this.runGit(
      cwd,
      ['status', '--porcelain'],
      TIMEOUT_LOCAL_MS
    );
    if (!res.success) return res;
    return { success: true, data: res.data.stdout.trim().length > 0 };
  }

  private async ensureCleanRepo(cwd: string): Promise<RepoResult<true>> {
    const dirty = await this.hasTrackedChanges(cwd);
    if (!dirty.success) return dirty;
    if (dirty.data) {
      return {
        success: false,
        error: {
          code: 'DIRTY_REPO',
          message: 'Repository has uncommitted changes',
        },
      };
    }
    return { success: true, data: true };
  }

  private async listAllRefs(cwd: string): Promise<RepoResult<string[]>> {
    const res = await this.runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      TIMEOUT_LOCAL_MS
    );
    if (!res.success) return res;
    const branches = res.data.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return { success: true, data: branches };
  }

  private async getCurrentBranch(
    cwd: string
  ): Promise<RepoResult<string | null>> {
    const res = await this.runGit(
      cwd,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      TIMEOUT_LOCAL_MS
    );
    if (!res.success) return res;
    const name = res.data.stdout.trim();
    return { success: true, data: name === 'HEAD' ? null : name };
  }

  private async getCurrentCommit(cwd: string): Promise<RepoResult<string>> {
    const res = await this.runGit(cwd, ['rev-parse', 'HEAD'], TIMEOUT_LOCAL_MS);
    if (!res.success) return res;
    return { success: true, data: res.data.stdout.trim() };
  }

  private async isUpToDateWithRemote(
    cwd: string,
    kind: RepoKind
  ): Promise<RepoResult<boolean>> {
    const branch = await this.getCurrentBranch(cwd);
    if (!branch.success) return branch;
    if (branch.data === null) {
      // Detached HEAD; nothing to compare to a tracking branch — up to date.
      return { success: true, data: true };
    }

    const upstreamCheck = await this.runGit(
      cwd,
      ['rev-parse', '--abbrev-ref', `${branch.data}@{u}`],
      TIMEOUT_LOCAL_MS
    );
    if (!upstreamCheck.success) {
      // No upstream configured (local-only branch) — nothing to compare, up
      // to date.
      return { success: true, data: true };
    }

    const fetch = await this.runNetworkGit(
      cwd,
      ['fetch', '--all', '--prune'],
      kind
    );
    if (!fetch.success) return fetch;

    const res = await this.runGit(
      cwd,
      ['rev-list', '--left-only', '--count', '@{u}...HEAD'],
      TIMEOUT_LOCAL_MS
    );
    if (!res.success) return res;
    const aheadCount = parseInt(res.data.stdout.trim() || '0', 10);
    return { success: true, data: aheadCount === 0 };
  }

  // `reset --hard` only — used by checkout flows to force a clean cloned
  // workspace before switching ref (matches the old cloned-repo plugin,
  // which does NOT also `clean -fd` here).
  private async hardReset(cwd: string): Promise<RepoResult<null>> {
    const res = await this.runGit(cwd, ['reset', '--hard'], TIMEOUT_LOCAL_MS);
    if (!res.success) return res;
    return { success: true, data: null };
  }

  // `reset --hard` + `clean -fd` — a fully pristine working tree, used by
  // `reset()` (both kinds) and cloned `pullChanges` (reset --hard alone
  // leaves untracked files behind, which can make a pull abort).
  private async makePristine(cwd: string): Promise<RepoResult<null>> {
    const res = await this.hardReset(cwd);
    if (!res.success) return res;
    const clean = await this.runGit(cwd, ['clean', '-fd'], TIMEOUT_LOCAL_MS);
    if (!clean.success) return clean;
    return { success: true, data: null };
  }

  // Network-touching git op (fetch/pull) with an SSH fallback for CLONED
  // repos: when the origin remote is HTTPS and the failure is auth-shaped,
  // permanently switch origin to the SSH form and retry once. This recovers
  // repos that were cloned over HTTPS (or saved before the SSH fallback
  // existed) on hosts where only SSH credentials work. LOCAL repos are the
  // user's own — their remotes are never touched.
  private async runNetworkGit(
    cwd: string,
    args: string[],
    kind: RepoKind,
    signal?: AbortSignal
  ): Promise<RepoResult<GitOutput>> {
    const first = await this.runGit(cwd, args, TIMEOUT_FETCH_MS, signal);
    if (
      first.success ||
      kind !== RepoKind.CLONED ||
      !GIT_AUTH_ERROR.test(first.error.message) ||
      signal?.aborted
    ) {
      return first;
    }

    const origin = await this.runGit(
      cwd,
      ['remote', 'get-url', 'origin'],
      TIMEOUT_LOCAL_MS
    );
    if (!origin.success) return first;
    const originUrl = origin.data.stdout.trim();
    const sshUrl = convertHttpsToSsh(originUrl);
    if (sshUrl === originUrl) return first;

    getLogger().info(
      `HTTPS ${args[0]} in ${cwd} was rejected (auth); switching origin to SSH (${sshUrl}) and retrying`
    );
    const setUrl = await this.runGit(
      cwd,
      ['remote', 'set-url', 'origin', sshUrl],
      TIMEOUT_LOCAL_MS
    );
    if (!setUrl.success) return first;

    const second = await this.runGit(cwd, args, TIMEOUT_FETCH_MS, signal);
    if (!second.success) {
      // Neither transport works — restore the original URL so the remote
      // config doesn't flip-flop on every retry.
      await this.runGit(
        cwd,
        ['remote', 'set-url', 'origin', originUrl],
        TIMEOUT_LOCAL_MS
      );
      return first;
    }
    return second;
  }

  // Every git invocation goes through here so the safety rails (hooks
  // disabled, protocol allowlist, no interactive prompts) are structurally
  // impossible to bypass. Mirrors the old plugin-side execGit contract: any
  // failure — spawn error, timeout, abort, or a non-zero exit — comes back
  // as GIT_COMMAND_FAILED rather than throwing, so callers never need a
  // try/catch around a git call. Error messages are credential-redacted:
  // git happily echoes credentialed URLs into stderr.
  private async runGit(
    cwd: string,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    pinned = false
  ): Promise<RepoResult<GitOutput>> {
    let result: RunCommandResult;
    try {
      result = await this.run('git', [...HOOKS_OFF, ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_ALLOW_PROTOCOL,
          ...(pinned ? { GIT_LFS_SKIP_SMUDGE: '1' } : {}),
          // Never hang on an interactive credential prompt — this runs in a
          // server. Failing fast is what makes the SSH fallback reachable.
          GIT_TERMINAL_PROMPT: '0',
          // Same for SSH passphrase/host-key prompts; accept-new keeps
          // first-contact clones working without disabling host-key checks
          // entirely. An explicitly configured GIT_SSH_COMMAND wins.
          GIT_SSH_COMMAND:
            process.env.GIT_SSH_COMMAND ??
            'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
        },
        timeoutMs,
        signal,
      });
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GIT_COMMAND_FAILED',
          message: redactUrlCredentials(
            `git ${args.join(' ')} failed: ${errMsg(error)}`
          ),
        },
      };
    }
    if (result.code !== 0) {
      return {
        success: false,
        error: {
          code: 'GIT_COMMAND_FAILED',
          message: redactUrlCredentials(
            `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`
          ),
        },
      };
    }
    return {
      success: true,
      data: { stdout: result.stdout, stderr: result.stderr },
    };
  }
}
