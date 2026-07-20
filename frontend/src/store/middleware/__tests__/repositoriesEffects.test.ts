// @ts-expect-error Vitest is supplied by the repository test command via npx.
import { describe, expect, it, vi } from 'vitest';
import { setCurrentProfile } from '../../features/profiles/profilesSlice';
import { clearRepositoryList } from '../../features/repositories/repositoriesSlice';
import { repositoriesEffects } from '../repositoriesEffects';

describe('repositories effects', () => {
  it('clears the repo list explicitly when the selected profile changes', async () => {
    const dispatch = vi.fn();
    const next = vi.fn();
    const invoke = repositoriesEffects.middleware({
      dispatch,
      getState: () => ({}),
    } as never)(next);

    invoke(setCurrentProfile('profile-switch-regression'));

    await vi.waitFor(() =>
      expect(dispatch).toHaveBeenCalledWith(clearRepositoryList())
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
