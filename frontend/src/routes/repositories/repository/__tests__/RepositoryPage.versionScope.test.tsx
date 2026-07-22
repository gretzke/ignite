// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepoList, RepoVersionSummary } from '@ignite/api';
import RepositoryPage, { pinForInstalledVersion } from '../RepositoryPage';
import {
  repositoriesReducer,
  setRepositories,
} from '../../../../store/features/repositories/repositoriesSlice';
import { artifactListReceived, compilerReducer } from '../../../../store/features/compiler/compilerSlice';
import { deployDraftReducer } from '../../../../store/features/deployments/deployDraftSlice';

const url = 'https://example.test/contracts.git';
const installed: RepoVersionSummary = {
  url,
  commit: 'a'.repeat(40),
  refLabel: 'v1',
  lastUsedAt: '2026-07-18T00:00:00.000Z',
};

describe('RepositoryPage version scope validation', () => {
  it('renders compiling, ready contracts, and durable errors without assuming artifacts exist', () => {
    const repositories: RepoList = {
      session: null,
      local: [{
        pathOrUrl: '/workspace/contracts', initialized: true,
        frameworks: [{ id: 'foundry', name: 'Foundry' }], versions: [],
      }],
      cloned: [], versionGroups: [], pinned: [],
    };
    const makeStore = () => configureStore({
      reducer: { repositories: repositoriesReducer, compiler: compilerReducer, deployDraft: deployDraftReducer },
    });
    const render = (store: ReturnType<typeof makeStore>) => renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/repositories/${encodeURIComponent('/workspace/contracts')}`]}>
          <Routes><Route path="/repositories/:repoPath" element={<RepositoryPage />} /></Routes>
        </MemoryRouter>
      </Provider>
    );
    const pendingStore = makeStore();
    pendingStore.dispatch(setRepositories(repositories));
    pendingStore.dispatch(artifactListReceived({
      repoPath: '/workspace/contracts', frameworkId: 'foundry', pathOrUrl: '/workspace/contracts',
      result: { status: 'pending', jobId: 'job-compile' },
    }));
    expect(render(pendingStore)).toContain('Compiling');

    const readyStore = makeStore();
    readyStore.dispatch(setRepositories(repositories));
    readyStore.dispatch(artifactListReceived({
      repoPath: '/workspace/contracts', frameworkId: 'foundry', pathOrUrl: '/workspace/contracts',
      result: { status: 'ready', artifacts: [{ contractName: 'Counter', sourcePath: 'Counter.sol', artifactPath: 'out/Counter.json' }] },
    }));
    expect(render(readyStore)).toContain('Counter.sol');

    const failureStore = makeStore();
    failureStore.dispatch(setRepositories({
      ...repositories,
      local: [{ ...repositories.local[0], lastError: { code: 'COMPILE_FAILED', message: 'compile failed', at: '2026-07-22T00:00:00.000Z' } }],
    }));
    expect(render(failureStore)).toContain('Retry');
  });

  it('renders version-not-installed and mints no pin for an unknown version query', () => {
    const repositories: RepoList = {
      session: null,
      local: [{ pathOrUrl: '/workspace/contracts', initialized: true, versions: [installed] }],
      cloned: [],
      versionGroups: [],
      pinned: [],
    };
    const store = configureStore({
      reducer: { repositories: repositoriesReducer, compiler: compilerReducer },
    });
    store.dispatch(setRepositories(repositories));
    const unknownCommit = 'b'.repeat(40);

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/repositories/${encodeURIComponent(url)}?version=${unknownCommit}`]}>
          <Routes>
            <Route path="/repositories/:repoPath" element={<RepositoryPage />} />
          </Routes>
        </MemoryRouter>
      </Provider>
    );

    expect(html).toContain('This version is not installed for this repository.');
    expect(html).not.toContain(`· ${unknownCommit.slice(0, 12)}`);
    expect(pinForInstalledVersion(unknownCommit, undefined)).toBeUndefined();
  });
});
