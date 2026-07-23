// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { act, create } from 'react-test-renderer';
import type { WorkflowDocument } from '@ignite/api';
import { compilerReducer } from '../../../../store/features/compiler/compilerSlice';
import { deployDraftReducer } from '../../../../store/features/deployments/deployDraftSlice';
import {
  pluginsReducer,
  pluginsApi,
} from '../../../../store/features/plugins/pluginsSlice';
import { profilesReducer } from '../../../../store/features/profiles/profilesSlice';
import { repositoriesReducer } from '../../../../store/features/repositories/repositoriesSlice';
import { workflowsReducer } from '../../../../store/features/workflows/workflowsSlice';
import { workflowsApi } from '../../../../store/features/workflows/workflowsApi';
import { apiClient } from '../../../../store/api/client';
import SourceRow from '../components/SourceRow';
import WorkflowEditorPage from '../WorkflowEditorPage';

const document: WorkflowDocument = {
  schemaVersion: 1,
  sources: [
    {
      id: 'token',
      repo: { url: 'https://example.test/token', commit: 'a'.repeat(40) },
      frameworkId: 'foundry',
      sourcePath: 'src/Token.sol',
      contractName: 'Token',
      artifactPath: 'out/Token.json',
    },
  ],
  steps: [{ id: 'deploy-token', kind: 'deploy', contractId: 'token' }],
  requiredPlugins: [{ id: 'foundry', version: '1.0.0' }],
  outputs: { hooks: [] },
};

describe('WorkflowEditorPage saves argument edits', () => {
  it('marks an argument edit dirty, saves it, then starts installation', async () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const get = vi.spyOn(workflowsApi, 'get').mockImplementation(((
      _repo,
      _name,
      callbacks
    ) => {
      callbacks?.onSuccess?.({
        document,
        raw: JSON.stringify(document),
        docHash: 'b'.repeat(64),
      });
      return { type: 'test/get' } as never;
    }) as typeof workflowsApi.get);
    const status = vi
      .spyOn(workflowsApi, 'getWorkflowsStatus')
      .mockReturnValue([]);
    const refresh = vi.spyOn(pluginsApi, 'refresh').mockReturnValue([]);
    const save = vi.spyOn(workflowsApi, 'saveWorkflow').mockImplementation(((
      request
    ) => {
      request.onSaved?.('c'.repeat(64));
      return { type: 'test/save' } as never;
    }) as typeof workflowsApi.saveWorkflow);
    const install = vi
      .spyOn(workflowsApi, 'installWorkflow')
      .mockReturnValue({ type: 'test/install' } as never);
    const request = vi
      .spyOn(apiClient, 'request')
      .mockResolvedValue({ data: { deploymentTypes: [] } } as never);
    const store = configureStore({
      reducer: {
        compiler: compilerReducer,
        deployDraft: deployDraftReducer,
        plugins: pluginsReducer,
        profiles: profilesReducer,
        repositories: repositoriesReducer,
        workflows: workflowsReducer,
      },
    });
    const router = createMemoryRouter(
      [{ path: '/', element: <WorkflowEditorPage /> }],
      { initialEntries: ['/?workflowRepo=%2Frepo&workflow=release'] }
    );
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <Provider store={store}>
          <RouterProvider router={router} />
        </Provider>
      );
      await Promise.resolve();
    });

    const changed = globalThis.structuredClone(document);
    (
      changed.steps[0] as Extract<
        WorkflowDocument['steps'][number],
        { kind: 'deploy' }
      >
    ).args = {
      owner: `0x${'1'.repeat(40)}`,
    };
    await act(async () => {
      renderer!.root.findByType(SourceRow).props.onChange(changed);
    });
    const saveButton = renderer!.root
      .findAllByType('button')
      .find((button) =>
        button.children.some(
          (child) => typeof child === 'string' && child.includes('Save')
        )
      );

    expect(saveButton!.props.disabled).toBe(false);
    await act(async () => {
      saveButton!.props.onClick();
    });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        document: changed,
        baseDocHash: 'b'.repeat(64),
      })
    );
    expect(install).toHaveBeenCalledWith(
      {
        repoPathOrUrl: '/repo',
        name: 'release',
        expectedDocHash: 'c'.repeat(64),
      },
      undefined
    );

    get.mockRestore();
    status.mockRestore();
    refresh.mockRestore();
    save.mockRestore();
    install.mockRestore();
    request.mockRestore();
    vi.unstubAllGlobals();
  });
});
