import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for the container's global git config: execGit is the
// only way the plugin touches git, so recording config mutations here lets
// the test observe exactly the state a later credential-less operation sees.
const globalConfig = vi.hoisted(() => new Map<string, string>());

vi.mock('../../../../plugins/src/shared/utils/git.js', () => ({
  execGit: vi.fn(async (args: string[]) => {
    if (args[0] === 'config' && args[1] === '--global') {
      const rest = args.slice(2);
      if (rest[0] === '--unset' || rest[0] === '--unset-all') {
        globalConfig.delete(rest[1].toLowerCase());
        return { success: true, data: '' } as const;
      }
      if (rest[0] === '--remove-section') {
        for (const key of [...globalConfig.keys()]) {
          if (key.startsWith(`${rest[1].toLowerCase()}.`)) {
            globalConfig.delete(key);
          }
        }
        return { success: true, data: '' } as const;
      }
      globalConfig.set(rest[0].toLowerCase(), rest[1]);
      return { success: true, data: '' } as const;
    }
    return { success: true, data: '' } as const;
  }),
}));

// SSH key material never touches the real filesystem.
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));

import { RepoManagerPlugin } from '../../../../plugins/src/shared/base/repo-manager/index.js';
import type { GitCredentials } from '../../../../plugins/src/shared/base/repo-manager/types.js';

class TestRepoPlugin extends RepoManagerPlugin {
  public readonly metadata = {
    id: 'test-repo',
    type: 'repo-manager',
    name: 'Test',
    version: '0.0.0',
    baseImage: 'test',
  } as never;

  protected async getRepoUrl(): Promise<string | null> {
    return 'https://github.com/Uniswap/universal-router.git';
  }

  init = vi.fn() as never;
  checkoutBranch = vi.fn() as never;
  checkoutCommit = vi.fn() as never;
  getBranches = vi.fn() as never;
  pullChanges = vi.fn() as never;
  reset = vi.fn() as never;
  getRepoInfo = vi.fn() as never;
  getFile = vi.fn() as never;

  runWithCredentials<T>(
    credentials: GitCredentials | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.withGitCredentials(credentials, operation);
  }
}

const SSH_CREDENTIALS: GitCredentials = {
  type: 'ssh',
  privateKey: 'PRIVATE',
  publicKey: 'PUBLIC',
};

describe('RepoManagerPlugin credential cleanup', () => {
  beforeEach(() => {
    globalConfig.clear();
  });

  it('applies the insteadOf rewrite while the credentialed operation runs', async () => {
    const plugin = new TestRepoPlugin();
    let duringOperation: string[] = [];
    await plugin.runWithCredentials(SSH_CREDENTIALS, async () => {
      duringOperation = [...globalConfig.keys()];
      return 'ok';
    });
    expect(duringOperation.some((key) => key.endsWith('.insteadof'))).toBe(
      true
    );
  });

  it('removes the insteadOf rewrite after the operation (host-key regression)', async () => {
    const plugin = new TestRepoPlugin();
    await plugin.runWithCredentials(SSH_CREDENTIALS, async () => 'ok');

    // A leftover url.<ssh>.insteadOf makes every later credential-less fetch
    // rewrite the HTTPS remote to SSH and die with
    // "Host key verification failed".
    const leftovers = [...globalConfig.keys()].filter((key) =>
      key.endsWith('.insteadof')
    );
    expect(leftovers).toEqual([]);
  });

  it('removes the insteadOf rewrite even when the operation throws', async () => {
    const plugin = new TestRepoPlugin();
    await expect(
      plugin.runWithCredentials(SSH_CREDENTIALS, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const leftovers = [...globalConfig.keys()].filter((key) =>
      key.endsWith('.insteadof')
    );
    expect(leftovers).toEqual([]);
  });
});
