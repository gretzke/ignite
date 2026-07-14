import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/runCommand.js', () => ({
  runCommand: vi.fn(),
}));

import { IsolatedBuilder, SQUID_CONF } from '../../plugins/install/IsolatedBuilder.js';
import { runCommand } from '../../utils/runCommand.js';

const runCommandMock = vi.mocked(runCommand);

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('IsolatedBuilder egress ACL', () => {
  it('denies loopback, all RFC1918 ranges, and link-local before allowing', () => {
    const denyIdx = SQUID_CONF.indexOf('http_access deny private_dst');
    const allowIdx = SQUID_CONF.indexOf('http_access allow');
    expect(denyIdx).toBeGreaterThan(-1);
    // deny rule must appear before any allow rule (squid evaluates top-down)
    expect(denyIdx).toBeLessThan(allowIdx);
    for (const cidr of [
      '127.0.0.0/8',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '169.254.0.0/16',
      '::1/128',
      'fc00::/7',
      'fe80::/10',
      '::ffff:0:0/96',
    ]) {
      expect(SQUID_CONF).toContain(cidr);
    }
  });
});

describe('IsolatedBuilder Docker resource ownership', () => {
  it('labels every created container and network and removes anonymous volumes', async () => {
    const calls: string[][] = [];
    runCommandMock.mockImplementation(async (_command, args) => {
      calls.push(args);
      if (args[0] === 'inspect') {
        if (args[2].includes('IPAddress')) {
          return { code: 0, stdout: '172.20.0.2\n', stderr: '' };
        }
        const id = args[3].replace('ignite-buildkitd-', '');
        return {
          code: 0,
          stdout: `false||ignite-build-internal-${id},`,
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const prototype = IsolatedBuilder.prototype as unknown as {
      writeFileInContainer: () => Promise<void>;
      loadFromContainer: () => Promise<void>;
    };
    vi.spyOn(prototype, 'writeFileInContainer').mockResolvedValue(undefined);
    vi.spyOn(prototype, 'loadFromContainer').mockResolvedValue(undefined);

    await expect(
      new IsolatedBuilder().buildToTempTag('/tmp/context', 'Dockerfile')
    ).resolves.toMatch(/^ignite\/installing_git_[a-f0-9]{8}:build$/);

    const expectedLabels = [
      '--label',
      'ignite.managed=true',
      '--label',
      `ignite.pid=${process.pid}`,
      '--label',
      `ignite.host=${os.hostname()}`,
    ];
    const networkCreates = calls.filter(
      (args) => args[0] === 'network' && args[1] === 'create'
    );
    const runs = calls.filter((args) => args[0] === 'run');

    expect(networkCreates).toHaveLength(2);
    expect(runs).toHaveLength(2);
    for (const args of [...networkCreates, ...runs]) {
      expect(args).toEqual(expect.arrayContaining(expectedLabels));
    }

    const removals = calls.filter((args) => args[0] === 'rm');
    expect(removals).toHaveLength(2);
    for (const args of removals) {
      expect(args).toEqual([
        'rm',
        '-f',
        '-v',
        expect.stringMatching(/^ignite-build(?:kitd|-proxy)-[a-f0-9]{8}$/),
      ]);
    }
  });
});
