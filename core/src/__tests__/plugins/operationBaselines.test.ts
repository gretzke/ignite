import { describe, expect, it } from 'vitest';
import { PluginType } from '@ignite/plugin-types/types';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import {
  effectiveOperations,
  effectiveRepoRead,
  requiredPermissions,
} from '../../plugins/operationBaselines.js';

const metadata = (overrides: Partial<PluginMetadata> = {}): PluginMetadata => ({
  id: 'test-plugin',
  types: [PluginType.COMPILER],
  name: 'Test',
  version: '1.0.0',
  baseImage: 'ignite/test:latest',
  ...overrides,
});

describe('operation baselines', () => {
  it('uses declared operations in preference to legacy baselines', () => {
    expect(effectiveOperations(metadata({ operations: ['custom'] }))).toEqual([
      'custom',
    ]);
  });

  it('uses a stable deduplicated union for legacy multi-type manifests', () => {
    expect(
      effectiveOperations(
        metadata({
          types: [PluginType.COMPILER, PluginType.COMPILER, PluginType.VERIFIER],
        }),
      ),
    ).toContain('verify');
  });

  it('returns no operations for an unknown legacy type', () => {
    expect(
      effectiveOperations(metadata({ types: ['unknown' as PluginType] })),
    ).toEqual([]);
  });

  it('unions operation permission hints with host minimums', () => {
    expect(
      requiredPermissions(
        metadata({ operationPermissions: { compile: 'net' } }),
        'compile',
      ),
    ).toEqual(['net', 'repoWrite']);
  });

  it('preserves an explicit repoRead false and infers it for legacy compilers', () => {
    expect(effectiveRepoRead(metadata({ repoRead: false }))).toBe(false);
    expect(effectiveRepoRead(metadata())).toBe(true);
    expect(
      effectiveRepoRead(metadata({ types: [PluginType.VERIFIER] })),
    ).toBe(false);
  });

  it('defines the three deployment-hook operations without compiler repoRead inference', () => {
    const hook = metadata({ types: [PluginType.DEPLOYMENT_HOOK] });
    expect(effectiveOperations(hook)).toEqual([
      'describeDeploymentHook',
      'onRunCompleted',
      'suggestAddresses',
    ]);
    expect(effectiveRepoRead(hook)).toBe(false);
    expect(requiredPermissions(hook, 'describeDeploymentHook')).toEqual([]);
    expect(requiredPermissions(hook, 'onRunCompleted')).toEqual([]);
    expect(requiredPermissions(hook, 'suggestAddresses')).toEqual([]);
  });
});
