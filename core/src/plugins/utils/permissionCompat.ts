// Legacy-permission compatibility for the hostWrite → repoWrite rename.
//
// The permission only ever gated the repo-workspace bind mount (`:ro` unless
// granted) — the host filesystem is never mounted — so the id was renamed to
// match its actual scope. Manifests authored before the rename (and registry
// entries persisted from them) still declare 'hostWrite'; normalize those to
// 'repoWrite' wherever manifest-shaped permission requests enter core, so the
// rest of the system only ever sees the new id.
import type {
  PluginMetadata,
  PluginPermissionRequest,
  PluginType,
} from '@ignite/plugin-types/types';

export const LEGACY_REPO_WRITE_ID = 'hostWrite';

// Normalize a manifest's permission requests in place-shape (returns a new
// metadata object when a rename happened, the same object otherwise, so
// callers can cheaply detect whether anything changed). Deliberately does NOT
// validate — validation (unknown ids, duplicates, description shape) stays in
// PluginInstaller.validatePermissionRequests, which runs on the normalized
// output. A malformed permissions value is passed through untouched for the
// validator to reject.
export function normalizeLegacyPermissions(metadata: PluginMetadata): {
  metadata: PluginMetadata;
  renamed: boolean;
} {
  const permissions = metadata.permissions;
  if (!Array.isArray(permissions)) return { metadata, renamed: false };
  let renamed = false;
  const normalized = permissions.map((request) => {
    if (
      typeof request === 'object' &&
      request !== null &&
      (request as { id?: unknown }).id === LEGACY_REPO_WRITE_ID
    ) {
      renamed = true;
      return { ...request, id: 'repoWrite' } as PluginPermissionRequest;
    }
    return request;
  });
  if (!renamed) return { metadata, renamed: false };
  return { metadata: { ...metadata, permissions: normalized }, renamed: true };
}

// Manifests written before the types[] migration carry a single `type`
// string. Normalize on every read path so downstream code can treat
// metadata.types as the canonical capability list.
export function normalizeLegacyType(
  metadata: PluginMetadata & { type?: PluginType }
): PluginMetadata {
  if (Array.isArray(metadata.types) && metadata.types.length > 0) {
    return metadata;
  }
  const { type, ...rest } = metadata;
  if (!type) {
    throw new Error(
      `Plugin manifest ${metadata.id ?? '<unknown>'} declares neither types[] nor a legacy type`
    );
  }
  return { ...rest, types: [type] };
}
