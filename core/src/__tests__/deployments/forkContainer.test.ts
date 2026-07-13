import { describe, expect, it, vi } from 'vitest';
import {
  makeForkRunner,
  sweepForkContainers,
} from '../../deployments/forkContainer.js';

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

  it('sweeps only containers carrying the simulation label', async () => {
    const remove = vi.fn(async () => undefined);
    const listContainers = vi.fn(async () => [{ Id: 'leftover' }]);
    await sweepForkContainers({
      docker: {
        inspectImage: vi.fn(),
        createContainer: vi.fn(),
        getContainer: vi.fn(() => ({ remove })),
        listContainers,
      } as never,
    });
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: ['ignite-simfork=1'] },
    });
    expect(remove).toHaveBeenCalledWith({ force: true });
  });
});
