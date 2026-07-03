import { describe, it, expect } from 'vitest';
import { PluginInstallSourceSchema } from '@ignite/api';

describe('PluginInstallSourceSchema — git variant', () => {
  it('accepts a git source with url only', () => {
    const r = PluginInstallSourceSchema.safeParse({
      kind: 'git',
      url: 'https://github.com/acme/waffle-plugin',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a git source with an optional ref', () => {
    const r = PluginInstallSourceSchema.safeParse({
      kind: 'git',
      url: 'https://github.com/acme/waffle-plugin',
      ref: 'v1.2.3',
    });
    expect(r.success).toBe(true);
  });

  it('still accepts the local variant', () => {
    const r = PluginInstallSourceSchema.safeParse({
      kind: 'local',
      contextDir: '/src/x',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a git source with an empty url', () => {
    const r = PluginInstallSourceSchema.safeParse({ kind: 'git', url: '' });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const r = PluginInstallSourceSchema.safeParse({ kind: 'svn', url: 'x' });
    expect(r.success).toBe(false);
  });
});
