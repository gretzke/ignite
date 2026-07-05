import { describe, it, expect, vi } from 'vitest';
import { createProfileHandlers } from '../../api/profiles.js';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

const profile = {
  id: 'p1',
  name: 'One',
  color: '#fff',
  icon: 'flame',
  created: '2024-01-01T00:00:00.000Z',
  lastUsed: '2024-01-01T00:00:00.000Z',
};

function makeDeps() {
  return {
    getProfileManager: async () => ({
      getCurrentProfile: () => 'p1',
      getCurrentProfileConfig: async () => profile,
      getProfileConfig: async (id: string) => ({ ...profile, id }),
      listProfiles: async () => [profile],
      listArchivedProfiles: async () => [],
      createProfile: async () => profile,
      switchProfile: vi.fn(async () => {}),
      updateProfile: async () => ({ ...profile, name: 'Two' }),
      archiveProfile: vi.fn(async () => {}),
      restoreProfile: vi.fn(async () => {}),
      deleteProfile: vi.fn(async () => {}),
    }),
    repoRegistry: {
      list: async () => ({ session: null, local: [], cloned: [] }),
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  };
}

describe('profile handlers', () => {
  it('listProfiles returns currentId and profiles', async () => {
    const handlers = createProfileHandlers(makeDeps());
    const reply = makeReply();
    await handlers.listProfiles({} as never, reply as never);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({
      data: { currentId: 'p1', profiles: [profile] },
    });
  });

  it('maps thrown errors to the legacy 500 body', async () => {
    const deps = makeDeps();
    deps.getProfileManager = async () => {
      throw new Error('disk gone');
    };
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.listProfiles({} as never, reply as never);
    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'PROFILE_LIST_ERROR',
      message: 'Failed to list profiles',
      details: { error: 'disk gone' },
    });
  });

  it('saveRepo returns 204 and delegates to the registry', async () => {
    const deps = makeDeps();
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.saveRepo(
      { params: { id: 'p1' }, body: { pathOrUrl: '/repo' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(204);
    expect(deps.repoRegistry.save).toHaveBeenCalledWith('p1', '/repo');
  });

  it('deleteRepo failure keeps code PROFILE_REPO_DELETE_ERROR', async () => {
    const deps = makeDeps();
    deps.repoRegistry.remove = vi.fn(async () => {
      throw new Error('nope');
    });
    const handlers = createProfileHandlers(deps);
    const reply = makeReply();
    await handlers.deleteRepo(
      { params: { id: 'p1' }, query: { pathOrUrl: '/repo' } } as never,
      reply as never
    );
    expect(reply.statusCode).toBe(500);
    expect((reply.body as { code: string }).code).toBe(
      'PROFILE_REPO_DELETE_ERROR'
    );
  });
});
