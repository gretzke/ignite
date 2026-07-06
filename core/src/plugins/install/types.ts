import type { PluginMetadata } from '@ignite/plugin-types/types';

// Where a self-contained installed-plugin image carries its bundle. Baked in
// by the build backends and invoked by both finalizeImage (getInfo probe) and
// PluginExecutionUtils (operation exec).
export const INSTALLED_PLUGIN_ENTRYPOINT = '/plugin/index.js';

// What a git install tracks — drives update semantics: a branch (update when
// the remote head moves), a release (update when a newer semver tag exists),
// or a pinned commit (never prompts to update).
export type GitTrack =
  | { mode: 'release'; version: string }
  | { mode: 'branch'; branch: string }
  | { mode: 'commit' };

// Discriminated union of install sources. Spec A: local folder (host build).
// Spec B: git URL (isolated build). Downstream (PluginInstaller, API, tab) is
// source-agnostic; only the build backends branch on `kind`. For git sources
// the registry additionally records what the install tracks, the resolved
// commit that was built, and the GitHub repo description (all server-derived).
export type PluginInstallSource =
  | { kind: 'local'; contextDir: string; dockerfile?: string }
  | {
      kind: 'git';
      url: string;
      ref?: string;
      track?: GitTrack;
      commit?: string;
      description?: string;
    };

export interface PluginBuildResult {
  imageTag: string;
  metadata: PluginMetadata;
  // Resolved HEAD sha of the clone that was built (git sources only).
  commit?: string;
}

// The swappable seam: Spec A builds from a local folder on the host; Spec B
// swaps in an isolated builder. Everything downstream is backend-independent.
export interface PluginBuildBackend {
  buildPluginImage(source: PluginInstallSource): Promise<PluginBuildResult>;
}
