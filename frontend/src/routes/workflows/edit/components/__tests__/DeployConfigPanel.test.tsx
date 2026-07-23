// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import {
  makeWorkflowDocumentSchema,
  validateWorkflowClosure,
  type WorkflowDocument,
} from '@ignite/api';
import {
  applyDeployStrategy,
  deployStrategyPlugins,
  validateStrategyParams,
} from '../DeployConfigPanel';
import DeployConfigPanel from '../DeployConfigPanel';
import { apiClient } from '../../../../../store/api/client';
import type { PluginRow } from '../../../../../store/features/plugins/pluginsSlice';

const document: WorkflowDocument = {
  schemaVersion: 1,
  sources: [
    {
      id: 'token',
      repo: { url: 'https://example.test/token', commit: 'a'.repeat(40) },
      frameworkId: 'compiler',
      sourcePath: 'Token.sol',
      contractName: 'Token',
      artifactPath: 'out/Token.json',
    },
  ],
  steps: [{ id: 'deploy-token', kind: 'deploy', contractId: 'token' }],
  requiredPlugins: [{ id: 'compiler', version: '1.0.0' }],
  outputs: { hooks: [] },
};

const row = (overrides: Partial<PluginRow>): PluginRow => ({
  pluginId: 'strategy',
  name: 'Strategy',
  version: '2.0.0',
  types: ['deployment-type'],
  trust: 'trusted',
  permissions: {
    repoWrite: false,
    net: false,
    contractBytecode: false,
    secrets: [],
  },
  requested: [],
  source: {
    kind: 'git',
    url: 'https://example.test/strategy',
    commit: 'b'.repeat(40),
  },
  ...overrides,
});

describe('DeployConfigPanel helpers', () => {
  it('excludes untrusted and non-strategy plugins', () => {
    expect(
      deployStrategyPlugins([
        row({ pluginId: 'trusted' }),
        row({ pluginId: 'untrusted', trust: 'untrusted' }),
        row({ pluginId: 'compiler', types: ['compiler'] }),
      ]).map((plugin) => plugin.pluginId)
    ).toEqual(['trusted']);
  });

  it('writes the strategy and appends its registry-pinned plugin entry', () => {
    const next = applyDeployStrategy(
      document,
      'deploy-token',
      {
        kind: 'plugin',
        pluginId: 'strategy',
        params: { mode: 'safe' },
        salt: `0x${'1'.repeat(64)}`,
      },
      row({})
    );
    expect(next.steps[0]).toMatchObject({
      strategy: { kind: 'plugin', pluginId: 'strategy' },
    });
    expect(next.requiredPlugins).toContainEqual(
      expect.objectContaining({ id: 'strategy', version: '2.0.0' })
    );
    expect(validateWorkflowClosure(next)).toEqual([]);
    expect(makeWorkflowDocumentSchema().safeParse(next).success).toBe(true);
  });

  it('rejects missing, invalid, and unknown descriptor params', () => {
    const descriptor = {
      pluginId: 'strategy',
      label: 'Strategy',
      description: '',
      validateSupported: true,
      params: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select' as const,
          required: true,
          options: [{ value: 'safe', label: 'Safe' }],
        },
        { key: 'retries', label: 'Retries', type: 'number' as const },
      ],
    };
    expect(
      validateStrategyParams(
        { mode: 'unsafe', retries: '2', old: true },
        descriptor
      )
    ).toEqual({
      mode: 'Choose one of the listed values.',
      retries: 'Use a number value.',
      old: 'This parameter is not supported by the selected deployment type.',
    });
  });

  it('keeps hook order stable when a source gains and loses its deploy step', async () => {
    const request = vi
      .spyOn(apiClient, 'request')
      .mockResolvedValue({ data: { deploymentTypes: [] } } as never);
    const onChange = vi.fn();
    const withoutDeploy = { ...document, steps: [] };
    let panel: ReturnType<typeof create>;

    await act(async () => {
      panel = create(
        <DeployConfigPanel
          document={document}
          sourceId="token"
          plugins={[]}
          onChange={onChange}
        />
      );
    });
    await act(async () => {
      panel!.update(
        <DeployConfigPanel
          document={withoutDeploy}
          sourceId="token"
          plugins={[]}
          onChange={onChange}
        />
      );
    });
    await act(async () => {
      panel!.update(
        <DeployConfigPanel
          document={document}
          sourceId="token"
          plugins={[]}
          onChange={onChange}
        />
      );
    });

    expect(panel!.toJSON()).not.toBeNull();
    request.mockRestore();
  });
});
