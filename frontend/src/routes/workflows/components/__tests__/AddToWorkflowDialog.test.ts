// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import type { ArtifactLocation, WorkflowDocument } from '@ignite/api';
import {
  appendArtifactsToWorkflow,
  canAddToWorkflow,
  compilerRequiredPlugin,
  workflowEditorPath,
  workflowSourceFromArtifact,
} from '../AddToWorkflowDialog';
import type { PluginRow } from '../../../../store/features/plugins/pluginsSlice';

const pin = {
  url: 'https://example.test/contracts.git',
  commit: 'a'.repeat(40),
  ref: 'v1.2.3',
  refKind: 'tag' as const,
};
const artifact: ArtifactLocation = {
  sourcePath: 'src/Counter.sol',
  contractName: 'Counter',
  artifactPath: 'out/Counter.sol/Counter.0.8.30.json',
};
const document: WorkflowDocument = {
  schemaVersion: 1,
  sources: [],
  steps: [],
  requiredPlugins: [],
  outputs: { hooks: [] },
};

const pluginRow = (overrides: Partial<PluginRow> = {}): PluginRow => ({
  pluginId: 'foundry',
  name: 'Foundry',
  types: ['compiler'],
  version: '1.2.3',
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
    url: 'https://example.test/foundry-plugin.git',
    commit: 'b'.repeat(40),
  },
  ...overrides,
});

describe('AddToWorkflowDialog helpers', () => {
  it('enables the workflow action only for version-scoped browsing', () => {
    expect(canAddToWorkflow()).toBe(false);
    expect(canAddToWorkflow(pin)).toBe(true);
  });

  it('builds the pinned selected artifact source and registry plugin entry', () => {
    expect(workflowSourceFromArtifact(artifact, pin, 'foundry')).toMatchObject({
      repo: pin,
      frameworkId: 'foundry',
      sourcePath: 'src/Counter.sol',
      contractName: 'Counter',
      artifactPath: 'out/Counter.sol/Counter.0.8.30.json',
    });
    expect(compilerRequiredPlugin('foundry', pluginRow()).plugin).toEqual({
      id: 'foundry',
      version: '1.2.3',
      source: pluginRow().source,
    });
  });

  it('strips credentials before recording a compiler plugin source', () => {
    const required = compilerRequiredPlugin(
      'foundry',
      pluginRow({
        source: {
          kind: 'git',
          url: 'https://user:secret@example.test/foundry.git',
          commit: 'b'.repeat(40),
        },
      })
    );
    expect(required.plugin?.source).toMatchObject({
      kind: 'git',
      url: 'https://example.test/foundry.git',
    });
    expect(required.credentialsRemoved).toBe(true);
  });

  it('blocks missing, untrusted, and non-compiler framework plugins', () => {
    expect(compilerRequiredPlugin('foundry', undefined).error).toContain(
      'Install and trust'
    );
    expect(
      compilerRequiredPlugin('foundry', pluginRow({ trust: 'untrusted' })).error
    ).toContain('Trust');
    expect(
      compilerRequiredPlugin(
        'foundry',
        pluginRow({ types: ['deployment-type'] })
      ).error
    ).toContain('compiler capability');
  });

  it('appends every selected artifact in one CAS payload', async () => {
    const plugin = compilerRequiredPlugin('foundry', pluginRow()).plugin!;
    const puts: Array<{ document: WorkflowDocument; baseDocHash: string }> = [];
    const result = await appendArtifactsToWorkflow(
      {
        getWorkflow: async () => ({ document, docHash: 'c'.repeat(64) }),
        putWorkflow: async (input) => {
          puts.push(input);
          return { docHash: 'd'.repeat(64) };
        },
      },
      {
        target: { repoPathOrUrl: '/workflows', name: 'release' },
        artifacts: [
          artifact,
          {
            ...artifact,
            contractName: 'Treasury',
            artifactPath: 'out/Treasury.sol/Treasury.0.8.30.json',
          },
        ],
        pin,
        frameworkId: 'foundry',
        requiredPlugin: plugin,
      }
    );

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      baseDocHash: 'c'.repeat(64),
      document: {
        requiredPlugins: [plugin],
        sources: [
          { repo: pin, artifactPath: artifact.artifactPath },
          { artifactPath: 'out/Treasury.sol/Treasury.0.8.30.json' },
        ],
      },
    });
    expect(result.sourceIds).toEqual(['counter-1', 'treasury-1']);
  });

  it('retries one document conflict, then surfaces a second conflict', async () => {
    const plugin = compilerRequiredPlugin('foundry', pluginRow()).plugin!;
    let gets = 0;
    let puts = 0;
    const conflict = {
      status: 409,
      body: { code: 'WORKFLOW_DOC_CONFLICT' },
    };

    await expect(
      appendArtifactsToWorkflow(
        {
          getWorkflow: async () => {
            gets += 1;
            return { document, docHash: `${gets}`.repeat(64) };
          },
          putWorkflow: async () => {
            puts += 1;
            throw conflict;
          },
        },
        {
          target: { repoPathOrUrl: '/workflows', name: 'release' },
          artifacts: [artifact],
          pin,
          frameworkId: 'foundry',
          requiredPlugin: plugin,
        }
      )
    ).rejects.toBe(conflict);

    expect(gets).toBe(2);
    expect(puts).toBe(2);
  });

  it('reloads and saves once after a document conflict', async () => {
    const plugin = compilerRequiredPlugin('foundry', pluginRow()).plugin!;
    let gets = 0;
    let puts = 0;
    const result = await appendArtifactsToWorkflow(
      {
        getWorkflow: async () => {
          gets += 1;
          return { document, docHash: `${gets}`.repeat(64) };
        },
        putWorkflow: async () => {
          puts += 1;
          if (puts === 1)
            throw {
              status: 409,
              body: { code: 'WORKFLOW_DOC_CONFLICT' },
            };
          return { docHash: 'e'.repeat(64) };
        },
      },
      {
        target: { repoPathOrUrl: '/workflows', name: 'release' },
        artifacts: [artifact],
        pin,
        frameworkId: 'foundry',
        requiredPlugin: plugin,
      }
    );

    expect(gets).toBe(2);
    expect(puts).toBe(2);
    expect(result.docHash).toBe('e'.repeat(64));
  });

  it('navigates to the editor with the new source highlighted', () => {
    expect(
      workflowEditorPath(
        { repoPathOrUrl: '/workflow repo', name: 'release' },
        'counter-1'
      )
    ).toBe(
      '/workflows/edit?workflowRepo=%2Fworkflow+repo&workflow=release&highlight=counter-1'
    );
  });
});
