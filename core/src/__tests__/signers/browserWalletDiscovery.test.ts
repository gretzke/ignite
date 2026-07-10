import { describe, it, expect } from 'vitest';
import {
  keyDiscoveredProviders,
  providerDetailForTest,
  type Eip1193Provider,
} from '../../../../plugins/src/signer-provider/browser-wallet/index.ts';

const provider: Eip1193Provider = { request: async () => null };

describe('keyDiscoveredProviders', () => {
  it('keys unique rdns announcements by rdns', () => {
    const keyed = keyDiscoveredProviders([
      providerDetailForTest('io.metamask', 'MetaMask', provider),
      providerDetailForTest('io.rabby', 'Rabby', provider),
    ]);
    expect([...keyed.keys()].sort()).toEqual(['io.metamask', 'io.rabby']);
  });

  it('disambiguates colliding rdns with the wallet name, order-independently', () => {
    const metamask = providerDetailForTest('io.metamask', 'MetaMask', provider);
    const flask = providerDetailForTest(
      'io.metamask',
      'MetaMask Flask',
      provider
    );

    const forward = keyDiscoveredProviders([metamask, flask]);
    const reverse = keyDiscoveredProviders([flask, metamask]);
    const expected = ['io.metamask~metamask', 'io.metamask~metamask-flask'];
    expect([...forward.keys()].sort()).toEqual(expected);
    expect([...reverse.keys()].sort()).toEqual(expected);
    // Each key resolves to the wallet whose name it embeds — never the
    // last announcer.
    expect(forward.get('io.metamask~metamask-flask')?.info.name).toBe(
      'MetaMask Flask'
    );
    expect(reverse.get('io.metamask~metamask-flask')?.info.name).toBe(
      'MetaMask Flask'
    );
  });
});
