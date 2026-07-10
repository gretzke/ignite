import { describe, it, expect } from 'vitest';
import {
  collapseSharedTransports,
  keyDiscoveredProviders,
  providerDetailForTest,
  type Eip1193Provider,
} from '../../../../plugins/src/signer-provider/browser-wallet/index.ts';

const provider: Eip1193Provider = { request: async () => null };

describe('keyDiscoveredProviders', () => {
  it('keys every wallet by rdns and name, independent of who else announced', () => {
    const metamask = providerDetailForTest('io.metamask', 'MetaMask', provider);
    const flask = providerDetailForTest(
      'io.metamask',
      'MetaMask Flask',
      provider
    );

    // The key for a wallet must be identical whether it announces alone or
    // alongside a collider — otherwise account ids issued in one discovery
    // round stop resolving in the next.
    const alone = keyDiscoveredProviders([flask]);
    const together = keyDiscoveredProviders([metamask, flask]);
    const reversed = keyDiscoveredProviders([flask, metamask]);

    expect([...alone.keys()]).toEqual(['io.metamask~metamask-flask']);
    expect([...together.keys()].sort()).toEqual([
      'io.metamask~metamask',
      'io.metamask~metamask-flask',
    ]);
    expect([...reversed.keys()].sort()).toEqual([
      'io.metamask~metamask',
      'io.metamask~metamask-flask',
    ]);
    expect(together.get('io.metamask~metamask-flask')?.info.name).toBe(
      'MetaMask Flask'
    );
    expect(reversed.get('io.metamask~metamask-flask')?.info.name).toBe(
      'MetaMask Flask'
    );
  });
});

describe('collapseSharedTransports', () => {
  it('keeps wallets with distinct providers separate', () => {
    const a: Eip1193Provider = { request: async () => null };
    const b: Eip1193Provider = { request: async () => null };
    const collapsed = collapseSharedTransports(
      keyDiscoveredProviders([
        providerDetailForTest('io.metamask', 'MetaMask', a),
        providerDetailForTest('io.metamask', 'MetaMask Flask', b),
      ])
    );
    expect(collapsed.size).toBe(2);
  });

  it('collapses announcements sharing one provider object into a single honest entry', () => {
    const shared: Eip1193Provider = { request: async () => null };
    const collapsed = collapseSharedTransports(
      keyDiscoveredProviders([
        providerDetailForTest('io.metamask', 'MetaMask', shared),
        providerDetailForTest('io.metamask', 'MetaMask Flask', shared),
      ])
    );
    expect(collapsed.size).toBe(1);
    const [key, detail] = [...collapsed.entries()][0];
    expect(key).toBe('io.metamask~metamask');
    expect(detail.info.name).toBe('MetaMask / MetaMask Flask');
  });
});
