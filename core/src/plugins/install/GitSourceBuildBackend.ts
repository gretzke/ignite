import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { getLogger } from '../../utils/logger.js';
import { runCommand } from '../../utils/runCommand.js';
import type {
  PluginBuildBackend,
  PluginBuildResult,
  PluginInstallSource,
} from './types.js';
import { IsolatedBuilder } from './IsolatedBuilder.js';
import { finalizeBuiltImage } from './finalizeImage.js';

const CLONE_TIMEOUT_MS = 2 * 60 * 1000;

// Schemes we trust git to clone over. Anything else (notably ext:: and fd::,
// which can execute an arbitrary host command/inherit an arbitrary fd) is
// rejected up front so this guard doesn't depend on the host's git having
// protocol.allow left at its safe compiled default.
const ALLOWED_URL_SCHEMES = ['https://', 'git://', 'ssh://', 'file://'];

// Spec B backend: clones a git repo (hooks disabled — clone itself runs no repo
// code, but disable hooks defensively) and builds it inside the IsolatedBuilder,
// so untrusted build-time code (RUN steps, npm lifecycle scripts) can never
// touch the host. Produces the same { imageTag, metadata } as the local backend.
export class GitSourceBuildBackend implements PluginBuildBackend {
  private docker = new Docker();
  private builder = new IsolatedBuilder();

  async buildPluginImage(
    source: PluginInstallSource
  ): Promise<PluginBuildResult> {
    if (source.kind !== 'git') {
      throw new Error(
        `GitSourceBuildBackend cannot handle source kind '${source.kind}'`
      );
    }
    const lowerUrl = source.url.toLowerCase();
    if (!ALLOWED_URL_SCHEMES.some((scheme) => lowerUrl.startsWith(scheme))) {
      throw new Error(
        `Refusing to clone plugin source: unsupported URL scheme in '${source.url}'. ` +
          `Only ${ALLOWED_URL_SCHEMES.join(', ')} are allowed.`
      );
    }
    const cloneDir = await mkdtemp(path.join(tmpdir(), 'ignite-git-'));
    try {
      await this.clone(source.url, source.ref, cloneDir);
      const commit = await this.headCommit(cloneDir);
      // Dockerfile is expected at the repo root (the third-party plugin convention).
      const tempTag = await this.builder.buildToTempTag(cloneDir, 'Dockerfile');
      const finalized = await finalizeBuiltImage(this.docker, tempTag);
      return { ...finalized, ...(commit ? { commit } : {}) };
    } finally {
      await rm(cloneDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // The exact sha that was built — recorded in the registry so update checks
  // can compare against the remote head.
  private async headCommit(dir: string): Promise<string | undefined> {
    const result = await runCommand('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      timeoutMs: 10_000,
    });
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  // Shallow clone with hooks disabled. -c core.hooksPath=/dev/null prevents any
  // repo-supplied hook from running; --depth 1 keeps it fast. Branch/tag refs
  // use `clone --branch`; a full commit sha (which clone can't check out
  // directly) is fetched by sha instead — GitHub and modern git servers allow
  // fetching reachable shas.
  private async clone(
    url: string,
    ref: string | undefined,
    dir: string
  ): Promise<void> {
    getLogger().info(
      `⬇️  Cloning plugin source from ${url}${ref ? `@${ref}` : ''}`
    );
    // Explicit protocol allowlist so a host gitconfig with
    // protocol.allow=always can't re-enable ext::/fd:: transports (which
    // can execute an arbitrary command / inherit an arbitrary fd) —
    // this must not depend on ambient host config for a security
    // boundary. The URL-scheme guard above is the first layer; this is
    // defense in depth in case a redirect or submodule URL slips one through.
    const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'https:git:ssh:file' };

    if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
      const steps: string[][] = [
        ['-c', 'core.hooksPath=/dev/null', 'init', '-q', dir],
        ['-C', dir, 'remote', 'add', 'origin', url],
        [
          '-C',
          dir,
          '-c',
          'core.hooksPath=/dev/null',
          'fetch',
          '--depth',
          '1',
          'origin',
          ref,
        ],
        [
          '-C',
          dir,
          '-c',
          'core.hooksPath=/dev/null',
          'checkout',
          '-q',
          'FETCH_HEAD',
        ],
      ];
      await this.runSteps(steps, env);
      return;
    }

    // Abbreviated sha: servers only allow fetching FULL shas over the wire,
    // so resolve the abbreviation locally — clone the whole repo (no
    // --depth) and checkout. Plugin repos are small; correctness beats the
    // extra bytes here.
    if (ref && /^[0-9a-f]{7,39}$/i.test(ref)) {
      const steps: string[][] = [
        [
          '-c',
          'core.hooksPath=/dev/null',
          'clone',
          '--no-tags',
          '--',
          url,
          dir,
        ],
        ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'checkout', '-q', ref],
      ];
      await this.runSteps(steps, env);
      return;
    }

    const args = [
      '-c',
      'core.hooksPath=/dev/null',
      'clone',
      '--depth',
      '1',
      '--no-tags',
    ];
    if (ref) args.push('--branch', ref);
    args.push('--', url, dir);
    const result = await runCommand('git', args, {
      env,
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(
        `git clone failed (exit ${result.code}): ${result.stderr.trim()}`
      );
    }
  }

  private async runSteps(
    steps: string[][],
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    for (const args of steps) {
      const result = await runCommand('git', args, {
        env,
        timeoutMs: CLONE_TIMEOUT_MS,
      });
      if (result.code !== 0) {
        throw new Error(
          `git ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`
        );
      }
    }
  }
}
