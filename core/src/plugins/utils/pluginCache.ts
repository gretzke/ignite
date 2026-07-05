// Per-plugin persistent cache volume. Every ephemeral plugin container gets a
// private named volume mounted read-write at PLUGIN_CACHE_MOUNT so plugins can
// keep state across runs (downloaded toolchains, package caches, ...). The
// volume is namespaced by plugin id — plugins can only poison their own future
// runs, which they could already do via their image — and is removed when the
// plugin is uninstalled.

export const PLUGIN_CACHE_MOUNT = '/cache';

// Advertised to plugin processes via this env var (docker exec inherits the
// container env), so plugins don't have to hardcode the mount point.
export const PLUGIN_CACHE_ENV = 'IGNITE_PLUGIN_CACHE';

// Plugin ids are validated to /^[a-z0-9][a-z0-9._-]*$/ at install time (and
// built-in ids follow the same shape), so the derived name is always a valid
// Docker volume name.
export function pluginCacheVolumeName(pluginId: string): string {
  return `ignite-plugin-cache-${pluginId}`;
}
