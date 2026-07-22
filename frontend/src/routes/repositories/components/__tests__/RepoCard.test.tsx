// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import RepoCard from '../RepoCard';
import {
  repositoriesReducer,
  setRepositories,
} from '../../../../store/features/repositories/repositoriesSlice';

describe('RepoCard lifecycle failures', () => {
  it('shows Failed and Retry instead of Ready and Detecting for a first lifecycle failure', () => {
    const store = configureStore({ reducer: { repositories: repositoriesReducer } });
    store.dispatch(setRepositories({
      session: null,
      local: [{
        pathOrUrl: '/workspace/contracts',
        initialized: true,
        frameworks: undefined,
        lastError: {
          code: 'COMPILE_FAILED',
          message: 'first compile failed',
          at: '2026-07-22T00:00:00.000Z',
        },
        versions: [],
      }],
      cloned: [], versionGroups: [], pinned: [],
    }));

    const html = renderToStaticMarkup(
      <Provider store={store}>
        <MemoryRouter>
          <RepoCard
            repo={{ name: 'contracts', path: '/workspace/contracts' }}
            variant="local"
            showPullButton={false}
            onResetRepo={() => undefined}
            onRetry={() => undefined}
          />
        </MemoryRouter>
      </Provider>
    );

    expect(html).toContain('Failed');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Ready');
    expect(html).not.toContain('Detecting');
  });
});
