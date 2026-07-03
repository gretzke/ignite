import { describe, it, expect } from 'vitest';
import { PluginExecutionUtils } from '../../plugins/utils/PluginExecutionUtils.js';

describe('buildExecCommand', () => {
  it('injects the bundle for built-in plugins (node -e)', () => {
    const cmd = PluginExecutionUtils.buildExecCommand(
      'builtin',
      'console.log(1)'
    );
    expect(cmd).toEqual(['node', '-e', 'console.log(1)']);
  });

  it('runs the baked-in bundle for installed plugins', () => {
    const cmd = PluginExecutionUtils.buildExecCommand('installed', null);
    expect(cmd).toEqual(['node', '/plugin/index.js']);
  });
});
