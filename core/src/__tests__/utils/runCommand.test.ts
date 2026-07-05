import { describe, it, expect } from 'vitest';
import { runCommand } from '../../utils/runCommand.js';

describe('runCommand', () => {
  it('captures stdout and exit code 0', async () => {
    const result = await runCommand('node', ['-e', 'console.log("hi")']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
  });

  it('resolves (not rejects) on non-zero exit, capturing stderr', async () => {
    const result = await runCommand('node', [
      '-e',
      'console.error("bad"); process.exit(3)',
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr.trim()).toBe('bad');
  });

  it('rejects on timeout', async () => {
    await expect(
      runCommand('node', ['-e', 'setTimeout(() => {}, 60000)'], {
        timeoutMs: 200,
      })
    ).rejects.toThrow(/timed out/);
  });
});
