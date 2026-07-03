import { describe, it, expect } from 'vitest';
import { GitSourceBuildBackend } from '../../plugins/install/GitSourceBuildBackend.js';

describe('GitSourceBuildBackend URL scheme guard', () => {
  it('rejects ext:: transport URLs before ever spawning git', async () => {
    const backend = new GitSourceBuildBackend();
    await expect(
      backend.buildPluginImage({
        kind: 'git',
        url: 'ext::sh -c "touch /tmp/pwned"',
      })
    ).rejects.toThrow(/unsupported URL scheme/i);
  });

  it('rejects fd:: transport URLs', async () => {
    const backend = new GitSourceBuildBackend();
    await expect(
      backend.buildPluginImage({ kind: 'git', url: 'fd::0' })
    ).rejects.toThrow(/unsupported URL scheme/i);
  });
});
