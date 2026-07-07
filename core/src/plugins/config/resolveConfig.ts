// Resolves a plugin's declared config schema into the flat object injected
// into a container's stdin options (see PluginExecutor.executeEphemeralPlugin).
// SECURITY-CRITICAL: this is the single gate between the vault and the
// container. A secret field's value is only ever read (getSecret is only
// ever called) when the grant covers it — native trust, or an explicit key
// in grant.secrets. Undeclared config keys (present in configValues but not
// in metadata.configFields) are never surfaced: the schema is authoritative.
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { PermissionGrant } from '../trust/TrustManager.js';
import type { ConfigValue } from './PluginConfigStore.js';

export interface ResolveConfigArgs {
  metadata: PluginMetadata;
  grant: PermissionGrant;
  configValues: Record<
    string,
    { global?: ConfigValue; perChain?: Record<string, ConfigValue> }
  >;
  // Bound to the plugin's VaultStore scope by the caller.
  getSecret: (key: string, chainId?: number) => Promise<string | undefined>;
  // ChainIds with a per-chain secret value stored, for perChain secret
  // fields. Derived upstream via VaultStore.listSecretKeys. Only needed when
  // the schema declares a perChain secret field.
  getSecretChainIds?: (key: string) => Promise<number[]>;
}

export async function resolveConfig(
  args: ResolveConfigArgs
): Promise<Record<string, unknown>> {
  const { metadata, grant, configValues, getSecret, getSecretChainIds } = args;
  const result: Record<string, unknown> = {};

  for (const field of metadata.configFields ?? []) {
    const slot = configValues[field.key];
    const global = slot?.global;
    const perChain = slot?.perChain;

    if (field.secret) {
      const granted =
        grant.trust === 'native' || grant.secrets.includes(field.key);
      if (!granted) continue; // Never call getSecret for an ungranted key.

      if (field.perChain) {
        const value = await resolvePerChainSecret(
          field.key,
          getSecret,
          getSecretChainIds
        );
        if (value !== undefined) result[field.key] = value;
      } else {
        const value = await getSecret(field.key);
        if (value !== undefined) result[field.key] = value;
      }
      continue;
    }

    if (field.perChain) {
      const value: Record<string, ConfigValue> = { ...(perChain ?? {}) };
      if (global !== undefined) value.default = global;
      if (Object.keys(value).length > 0) result[field.key] = value;
    } else if (global !== undefined) {
      result[field.key] = global;
    }
  }

  return result;
}

async function resolvePerChainSecret(
  key: string,
  getSecret: ResolveConfigArgs['getSecret'],
  getSecretChainIds: ResolveConfigArgs['getSecretChainIds']
): Promise<Record<string, string> | undefined> {
  const value: Record<string, string> = {};

  const globalSecret = await getSecret(key);
  if (globalSecret !== undefined) value.default = globalSecret;

  const chainIds = (await getSecretChainIds?.(key)) ?? [];
  for (const chainId of chainIds) {
    const chainSecret = await getSecret(key, chainId);
    if (chainSecret !== undefined) value[String(chainId)] = chainSecret;
  }

  return Object.keys(value).length > 0 ? value : undefined;
}
