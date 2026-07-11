// Resolves a plugin's declared config schema into the flat object injected
// into a container's stdin options (see PluginExecutor.executeEphemeralPlugin).
// SECURITY-CRITICAL: this is the single gate between the vault (and the host
// filesystem, for `file` fields) and the container. A secret field's value is
// only ever read (getSecret is only ever called) when the grant covers it —
// native trust, or an explicit key in grant.secrets. A `file` field's PATH is
// non-secret (visible in `values`, editable in Configure), but its CONTENTS
// are gated the same way: getFileContents is only ever called when the grant
// covers the field's key. Undeclared config keys (present in configValues but
// not in metadata.configFields) are never surfaced: the schema is
// authoritative.
import os from 'node:os';
import {
  LIST_ITEM_ID_PATTERN,
  type PluginMetadata,
} from '@ignite/plugin-types/types';
import type { PermissionGrant } from '../trust/TrustManager.js';
import type { ConfigPrimitive, ConfigValue } from './PluginConfigStore.js';

export interface ResolveConfigArgs {
  metadata: PluginMetadata;
  grant: PermissionGrant;
  configValues: Record<
    string,
    { global?: ConfigValue; perChain?: Record<string, ConfigPrimitive> }
  >;
  // Bound to the plugin's VaultStore scope by the caller.
  getSecret: (key: string, chainId?: number) => Promise<string | undefined>;
  // ChainIds with a per-chain secret value stored, for perChain secret
  // fields. Derived upstream via VaultStore.listSecretKeys. Only needed when
  // the schema declares a perChain secret field.
  getSecretChainIds?: (key: string) => Promise<number[]>;
  // Reads a host file's contents for a `file` field's (already-expanded)
  // path. undefined = unreadable, missing, or oversized — never call this
  // for an ungranted file field (security-critical, see module doc above).
  // Optional only so existing callers/tests without file fields don't need
  // to pass it; a schema with a file field but no getFileContents omits it.
  getFileContents?: (path: string) => Promise<string | undefined>;
  // A verifier operation is always for one chain. Narrowing at this single
  // resolution boundary prevents a container from receiving other chains'
  // per-chain values or secrets.
  opts?: { chainScope?: number };
}

export async function resolveConfig(
  args: ResolveConfigArgs
): Promise<Record<string, unknown>> {
  const {
    metadata,
    grant,
    configValues,
    getSecret,
    getSecretChainIds,
    getFileContents,
    opts,
  } = args;
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
          getSecretChainIds,
          opts?.chainScope
        );
        if (value !== undefined) result[field.key] = value;
      } else {
        const value = await getSecret(field.key);
        if (value !== undefined) result[field.key] = value;
      }
      continue;
    }

    if (field.type === 'file') {
      const granted =
        grant.trust === 'native' || grant.secrets.includes(field.key);
      if (!granted) continue; // Never call getFileContents for an ungranted key.

      const configuredPath = typeof global === 'string' ? global : undefined;
      const path = configuredPath ?? field.default;
      if (!path || !getFileContents) continue;

      const expanded = path.startsWith('~/')
        ? `${os.homedir()}${path.slice(1)}`
        : path;
      const contents = await getFileContents(expanded);
      if (contents !== undefined) result[field.key] = contents;
      continue;
    }

    if (field.type === 'list') {
      const items = Array.isArray(global) ? (global as unknown[]) : [];
      const secretItemFields = (field.itemFields ?? []).filter((f) => f.secret);
      const hasSecrets = secretItemFields.length > 0;
      const granted =
        grant.trust === 'native' || grant.secrets.includes(field.key);
      const inject = hasSecrets ? granted : true;
      const resolved: Record<string, string>[] = [];

      for (const raw of items) {
        const item = raw as { id?: unknown; values?: unknown };
        if (
          typeof item.id !== 'string' ||
          !LIST_ITEM_ID_PATTERN.test(item.id)
        ) {
          continue;
        }
        const values =
          item.values && typeof item.values === 'object'
            ? (item.values as Record<string, string>)
            : {};
        const entry: Record<string, string> = { id: item.id, ...values };
        if (granted) {
          for (const itemField of secretItemFields) {
            const secret = await getSecret(
              `${field.key}.${item.id}.${itemField.key}`
            );
            if (secret !== undefined) entry[itemField.key] = secret;
          }
        }
        resolved.push(entry);
      }

      if (inject) result[field.key] = resolved;
      continue;
    }

    if (field.perChain) {
      const value: Record<string, ConfigPrimitive> =
        opts?.chainScope === undefined
          ? { ...(perChain ?? {}) }
          : Object.fromEntries(
              Object.entries(perChain ?? {}).filter(
                ([chainId]) => chainId === String(opts.chainScope)
              )
            );
      if (global !== undefined && !Array.isArray(global)) {
        value.default = global;
      }
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
  getSecretChainIds: ResolveConfigArgs['getSecretChainIds'],
  chainScope?: number
): Promise<Record<string, string> | undefined> {
  const value: Record<string, string> = {};

  const globalSecret = await getSecret(key);
  if (globalSecret !== undefined) value.default = globalSecret;

  const chainIds = (await getSecretChainIds?.(key)) ?? [];
  for (const chainId of chainIds) {
    if (chainScope !== undefined && chainId !== chainScope) continue;
    const chainSecret = await getSecret(key, chainId);
    if (chainSecret !== undefined) value[String(chainId)] = chainSecret;
  }

  return Object.keys(value).length > 0 ? value : undefined;
}
