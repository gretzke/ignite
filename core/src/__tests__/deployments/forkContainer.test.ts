import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import { makeForkRunner } from '../../deployments/forkContainer.js';

describe('fork container lifecycle', () => {
  it('does not pull a missing foundry image', async () => {
    const inspectImage = vi.fn(async () => {
      throw new Error('missing');
    });
    const createContainer = vi.fn();
    await expect(
      makeForkRunner(
        { rpcUrl: 'https://secret.example', chainId: 1 },
        {
          docker: {
            inspectImage,
            createContainer,
            getContainer: vi.fn(),
            listContainers: vi.fn(),
          } as never,
        }
      )
    ).resolves.toBeUndefined();
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('labels fork containers with their owner and removes a created husk when start fails', async () => {
    const remove = vi.fn(async () => undefined);
    const createContainer = vi.fn(async () => ({
      start: vi.fn(async () => {
        throw new Error('start failed');
      }),
      stop: vi.fn(async () => undefined),
      remove,
    }));

    await makeForkRunner(
      { rpcUrl: 'https://secret.example', chainId: 1 },
      {
        docker: {
          inspectImage: vi.fn(async () => undefined),
          createContainer,
          getContainer: vi.fn(),
        } as never,
      }
    );

    expect(createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        Labels: expect.objectContaining({
          'ignite-simfork': '1',
          'ignite.managed': 'true',
          'ignite.pid': String(process.pid),
          'ignite.host': os.hostname(),
        }),
      })
    );
    expect(remove).toHaveBeenCalledWith({ force: true, v: true });
  });
});
