// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepoList, RepoVersionSummary } from '@ignite/api';
import FilePage from '../FilePage';
import { repositoriesReducer, setRepositories } from '../../../../../store/features/repositories/repositoriesSlice';
import { artifactListReceived, compilerReducer } from '../../../../../store/features/compiler/compilerSlice';
import { filesReducer } from '../../../../../store/features/files/filesSlice';
import { deployDraftReducer } from '../../../../../store/features/deployments/deployDraftSlice';

describe('FilePage version scope validation', () => {
  it('renders a compiling label while artifact serving is pending', () => {
    const repositories: RepoList = {
      session: null,
      local: [{ pathOrUrl: '/workspace/contracts', initialized: true, frameworks: [{ id: 'foundry', name: 'Foundry' }], versions: [] }],
      cloned: [], versionGroups: [], pinned: [],
    };
    const store = configureStore({
      reducer: { repositories: repositoriesReducer, compiler: compilerReducer, files: filesReducer, deployDraft: deployDraftReducer },
    });
    store.dispatch(setRepositories(repositories));
    store.dispatch(artifactListReceived({ repoPath: '/workspace/contracts', frameworkId: 'foundry', pathOrUrl: '/workspace/contracts', result: { status: 'busy' } }));
    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/repositories/${encodeURIComponent('/workspace/contracts')}/file/src%2FCounter.sol?framework=foundry`]}>
          <Routes><Route path="/repositories/:repoPath/file/*" element={<FilePage />} /></Routes>
        </MemoryRouter>
      </Provider>
    );
    expect(html).toContain('Compiling contracts...');
  });

  it('renders version-not-installed instead of reading the live file for an unknown version', () => {
    const url = 'https://example.test/contracts.git';
    const installed: RepoVersionSummary = { url, commit: 'a'.repeat(40), lastUsedAt: '2026-07-18T00:00:00.000Z' };
    const repositories: RepoList = {
      session: null,
      local: [{ pathOrUrl: '/workspace/contracts', initialized: true, versions: [installed] }],
      cloned: [],
      versionGroups: [],
      pinned: [],
    };
    const store = configureStore({
      reducer: {
        repositories: repositoriesReducer,
        compiler: compilerReducer,
        files: filesReducer,
        deployDraft: deployDraftReducer,
      },
    });
    store.dispatch(setRepositories(repositories));

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter initialEntries={[`/repositories/${encodeURIComponent(url)}/file/src%2FCounter.sol?version=${'b'.repeat(40)}`]}>
          <Routes><Route path="/repositories/:repoPath/file/*" element={<FilePage />} /></Routes>
        </MemoryRouter>
      </Provider>
    );

    expect(html).toContain('Version Not Installed');
    expect(html).toContain('This version is not installed for this repository.');
    expect(html).not.toContain('Loading source code...');
  });
});
