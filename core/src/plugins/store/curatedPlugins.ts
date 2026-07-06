import type { StorePluginData } from '@ignite/api';

// Curated plugin store catalog. Display name/description here are
// authoritative for the store UI; GitHub metadata (releases, live
// description) is layered on when the store modal inspects the repo.
//
// For now this ships with the app; if the catalog grows it can move to a
// hosted registry repo so it updates without an app release.
export const CURATED_PLUGINS: readonly StorePluginData[] = [
  {
    name: 'Waffle',
    description:
      'Compiles Waffle projects like Uniswap v2-core and v2-periphery. ' +
      'Hybrid solc resolution: bundles 0.5.16/0.6.6/0.8.x and downloads ' +
      'other versions on demand (cached).',
    repoUrl: 'https://github.com/gretzke/ignite-waffle-plugin',
  },
];
