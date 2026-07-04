import { describe, it, expect, vi } from 'vitest';

// Intercept the HTTP layer so client.request() never hits the network.
const httpMock = vi.hoisted(() => ({
  calls: [] as string[],
}));

vi.mock('../../../../shared/api/src/client/http.js', async (importOriginal) => {
  const orig =
    await importOriginal<
      typeof import('../../../../shared/api/src/client/http.js')
    >();
  return {
    ...orig,
    httpRequest: vi.fn(async (_method: string, url: string) => {
      httpMock.calls.push(url);
      return { data: { plugins: {} } };
    }),
  };
});

import { createClient } from '../../../../shared/api/src/client/index.js';

describe('api client request validation', () => {
  it('allows calling a querystring route without a query (Plugins tab regression)', async () => {
    const client = createClient({ baseUrl: 'http://localhost' });
    // listPlugins declares a querystring schema with only optional fields;
    // callers like pluginsApi.refresh() pass no query at all.
    await expect(client.request('listPlugins', {})).resolves.toEqual({
      data: { plugins: {} },
    });
  });

  it('still validates a provided query against the schema', async () => {
    const client = createClient({ baseUrl: 'http://localhost' });
    await expect(
      client.request('listPlugins', {
        query: { type: 'not-a-plugin-type' } as never,
      })
    ).rejects.toThrow();
  });
});
