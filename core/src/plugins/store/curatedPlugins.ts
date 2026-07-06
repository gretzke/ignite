import type { StorePluginData } from '@ignite/api';

// Curated plugin store catalog. Display name/description here are
// authoritative for the store UI; GitHub metadata (releases, live
// description) is layered on when the store modal inspects the repo.
//
// For now this ships with the app; if the catalog grows it can move to a
// hosted registry repo so it updates without an app release.
export const CURATED_PLUGINS: readonly StorePluginData[] = [
  {
    name: 'Waffle Plugin',
    description: 'Compiles Solidity projects that use the Waffle toolchain.',
    repoUrl: 'https://github.com/gretzke/ignite-waffle-plugin',
  },
];
