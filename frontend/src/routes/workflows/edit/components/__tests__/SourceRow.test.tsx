// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { act, create } from 'react-test-renderer';
import type {
  RepoWorkflowSource,
  WorkflowDocument,
  WorkflowStatusEntry,
} from '@ignite/api';
import { cascadeRemoveSource } from '@ignite/api';
import { compilerReducer } from '../../../../../store/features/compiler/compilerSlice';
import { apiClient } from '../../../../../store/api/client';
import SourceRow, {
  constructorPointerOptions,
  setConstructorArgument,
} from '../SourceRow';

const commit = 'a'.repeat(40);
const artifact = {
  solidityVersion: '0.8.28',
  optimizer: true,
  optimizerRuns: 200,
  viaIR: false,
  bytecodeHash: 'hash',
  abi: [
    {
      type: 'constructor',
      inputs: [
        { name: 'owner', type: 'address' },
        { name: 'supply', type: 'uint256' },
      ],
    },
  ],
  creationCode: '0x00',
  deployedBytecode: '0x00',
};

function document(): WorkflowDocument {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: 'token',
        repo: {
          url: 'https://example.test/token',
          commit,
          ref: 'v1',
          refKind: 'tag',
        },
        frameworkId: 'foundry',
        sourcePath: 'src/Token.sol',
        contractName: 'Token',
        artifactPath: 'out/Token.json',
      },
      {
        id: 'treasury',
        repo: {
          url: 'https://example.test/treasury',
          commit,
          ref: 'v2',
          refKind: 'tag',
        },
        frameworkId: 'foundry',
        sourcePath: 'src/Treasury.sol',
        contractName: 'Treasury',
        artifactPath: 'out/Treasury.json',
      },
    ],
    steps: [
      { id: 'deploy-token', kind: 'deploy', contractId: 'token' },
      { id: 'deploy-treasury', kind: 'deploy', contractId: 'treasury' },
    ],
    requiredPlugins: [{ id: 'foundry', version: '1.0.0' }],
    outputs: { hooks: [] },
  };
}

function tokenSource(value: WorkflowDocument): RepoWorkflowSource {
  return value.sources[0] as RepoWorkflowSource;
}

const readyStatus = (): WorkflowStatusEntry => ({
  name: 'release',
  valid: true,
  installState: 'ready',
  sources: [
    { id: 'token', ready: true },
    { id: 'treasury', ready: true },
  ],
});

async function renderRow(
  value = document(),
  status: WorkflowStatusEntry | undefined = readyStatus()
) {
  const store = configureStore({ reducer: { compiler: compilerReducer } });
  const onChange = vi.fn();
  const request = vi
    .spyOn(apiClient, 'request')
    .mockImplementation(((endpoint: string) =>
      Promise.resolve(
        endpoint === 'getArtifactData'
          ? ({ data: artifact } as never)
          : ({ data: { deploymentTypes: [] } } as never)
      )) as typeof apiClient.request);
  const render = (next: WorkflowDocument) => (
    <Provider store={store}>
      <SourceRow
        source={tokenSource(next)}
        document={next}
        status={status}
        plugins={[]}
        onChange={onChange}
        onRemove={() => undefined}
      />
    </Provider>
  );
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(render(value));
    await Promise.resolve();
  });
  return {
    renderer: renderer!,
    onChange,
    request,
    rerender: async (next: WorkflowDocument) => {
      await act(async () => {
        renderer!.update(render(next));
      });
    },
  };
}

describe('SourceRow constructor arguments', () => {
  it('renders installed constructor inputs from the pinned artifact', async () => {
    const { renderer, request } = await renderRow();

    expect(renderer.root.findByType('summary').children).toEqual(['Arguments']);
    expect(
      renderer.root.findAllByProps({ placeholder: '0x… address' })
    ).toHaveLength(1);
    expect(
      renderer.root.findAllByProps({ placeholder: 'Decimal integer' })
    ).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('getArtifactData', {
      body: {
        pathOrUrl: 'https://example.test/token',
        pluginId: 'foundry',
        artifactPath: 'out/Token.json',
        pin: tokenSource(document()).repo,
      },
    });
    request.mockRestore();
  });

  it('stores address pointers, excludes the current step, and labels targets', async () => {
    const { renderer, onChange, request, rerender } = await renderRow();
    const pointer = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === 'Pointer');

    await act(async () => {
      pointer!.props.onClick();
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({
            id: 'deploy-token',
            args: {
              owner: { $ref: { kind: 'step', stepId: 'deploy-treasury' } },
            },
          }),
        ]),
      })
    );
    await rerender(onChange.mock.calls.at(-1)![0] as WorkflowDocument);
    const pointerSelect = renderer.root
      .findAllByType('select')
      .find((select) =>
        select
          .findAllByType('option')
          .some((option) => option.children.join('') === 'Choose a deployment')
      );
    expect(
      pointerSelect!
        .findAllByType('option')
        .map((option) => option.children.join(''))
    ).toEqual(['Choose a deployment', 'Treasury · v2@aaaaaaa']);
    expect(constructorPointerOptions(document(), 'deploy-token')).toEqual([
      {
        stepId: 'deploy-treasury',
        label: 'Treasury · v2@aaaaaaa',
      },
    ]);
    expect(
      constructorPointerOptions(document(), 'deploy-token', ['treasury'])
    ).toEqual([
      {
        stepId: 'deploy-treasury',
        label: 'Treasury · v2@aaaaaaa',
        disabledReason: 'Source is being removed',
      },
    ]);
    request.mockRestore();
  });

  it('keeps untouched empty argument keys absent', async () => {
    const { renderer, onChange, request } = await renderRow();
    const input = renderer.root.findByProps({ placeholder: '0x… address' });

    await act(async () => {
      input.props.onChange({ target: { value: '' } });
    });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        steps: expect.arrayContaining([
          expect.objectContaining({ id: 'deploy-token' }),
        ]),
      })
    );
    const next = onChange.mock.calls.at(-1)![0] as WorkflowDocument;
    expect(
      next.steps.find((step) => step.id === 'deploy-token')
    ).not.toHaveProperty('args');
    request.mockRestore();
  });

  it('shows an install hint before the source artifact is ready', async () => {
    const { renderer, request } = await renderRow(document(), {
      ...readyStatus(),
      installState: 'not-installed',
    });

    expect(renderer.root.findAllByType('summary')).toHaveLength(0);
    expect(
      renderer.root.findAllByType('p').map((item) => item.children.join(''))
    ).toContain('Install the workflow to edit arguments.');
    expect(request).not.toHaveBeenCalledWith(
      'getArtifactData',
      expect.anything()
    );
    request.mockRestore();
  });

  it('includes an editor-created pointer in the removal cascade preview', () => {
    const withPointer = setConstructorArgument(
      document(),
      'deploy-token',
      'owner',
      { $ref: { kind: 'step', stepId: 'deploy-treasury' } }
    );
    const result = cascadeRemoveSource(withPointer, 'treasury');

    expect(result.clearedRefs).toContainEqual({
      stepId: 'deploy-token',
      path: '$.steps[0].args.owner.$ref.stepId',
    });
  });
});
