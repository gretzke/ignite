import { describe, it, expect } from 'vitest';
import {
  keyDiscoveredProviders,
  makeAccountId,
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

describe('makeAccountId', () => {
  it('lowercases the address so exact-match lookups survive casing drift', () => {
    expect(
      makeAccountId(
        'io.metamask~metamask-flask',
        '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
      )
    ).toBe(
      'io.metamask~metamask-flask:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
    );
  });
});

describe('shared-transport announcements', () => {
  it('keeps every issued wallet key valid even when providers share one object', () => {
    const shared: Eip1193Provider = { request: async () => null };
    const keyed = keyDiscoveredProviders([
      providerDetailForTest('io.metamask', 'MetaMask', shared),
      providerDetailForTest('io.metamask', 'MetaMask Flask', shared),
    ]);
    // Both aliases resolve — an account id issued while only one wallet had
    // announced must never stop resolving because the other showed up later.
    expect(keyed.get('io.metamask~metamask')?.provider).toBe(shared);
    expect(keyed.get('io.metamask~metamask-flask')?.provider).toBe(shared);
  });
});
