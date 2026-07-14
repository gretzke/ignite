// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  repositoriesReducer,
  removePinnedRepository,
} from '../../../../store/features/repositories/repositoriesSlice';
import PinnedRepoCard from '../PinnedRepoCard';

const pinned = {
  url: 'https://example.com/contracts.git',
  commit: 'abcdef0123456789abcdef0123456789abcdef01',
  refLabel: 'v1.2.3',
  refKind: 'tag' as const,
  frameworks: [{ id: 'foundry', name: 'Foundry' }],
};

describe('pinned repositories', () => {
  it('removes a pinned summary from repository state by url and commit', () => {
    let state = repositoriesReducer(undefined, { type: 'noop' });
    state = repositoriesReducer(state, {
      type: 'repositories/setRepositories',
      payload: { session: null, local: [], cloned: [], pinned: [pinned] },
    });
    state = repositoriesReducer(
      state,
      removePinnedRepository({ url: pinned.url, commit: pinned.commit })
    );
    expect(state.repositories?.pinned).toEqual([]);
  });

  it('renders a read-only pin, short commit, and framework badges without mutable repo controls', () => {
    const html = renderToStaticMarkup(
      <PinnedRepoCard pinned={pinned} onRemove={() => undefined} />
    );
    expect(html).toContain('https://example.com/contracts.git@v1.2.3');
    expect(html).toContain('abcdef0');
    expect(html).toContain('Foundry');
    expect(html).not.toContain('Pull');
    expect(html).not.toContain('Branch');
    expect(html).not.toContain('Reset');
  });
});
