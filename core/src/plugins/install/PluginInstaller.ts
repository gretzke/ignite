import Docker from 'dockerode';
import { stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  PluginMetadata,
  PluginPermissionRequest,
} from '@ignite/plugin-types/types';
import {
  PluginType,
  PLUGIN_PERMISSION_IDS,
  MAX_CONFIG_FIELDS,
} from '@ignite/plugin-types/types';
import { normalizeRepoUrl } from '@ignite/plugin-types';
import { PluginManager } from '../../filesystem/PluginManager.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { TrustManager } from '../trust/TrustManager.js';
import type { PluginPermissions } from '../trust/TrustManager.js';
import { VaultStore } from '../vault/VaultStore.js';
import { PluginConfigStore } from '../config/PluginConfigStore.js';
import { getLogger } from '../../utils/logger.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';
import { pluginCacheVolumeName } from '../utils/pluginCache.js';
import { deriveTrack, inspectGitRemote } from './gitRemote.js';
import type { InspectGitRemoteData } from '@ignite/api';
import type { PluginBuildBackend, PluginInstallSource } from './types.js';

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface PluginInstallerDeps {
  pluginManager: Pick<
    PluginManager,
    | 'addPlugin'
    | 'removePlugin'
    | 'hasPlugin'
    | 'getPlugin'
    | 'getInstallSource'
  >;
  loader: Pick<PluginRegistryLoader, 'isBuiltin'>;
  trust: {
    revoke: (pluginId: string) => Promise<void>;
    getGrant: (
      pluginId: string
    ) => Promise<{ trust: string } & PluginPermissions>;
    setTrust: (
      pluginId: string,
      trust: 'trusted' | 'untrusted',
      permissions: PluginPermissions
    ) => Promise<unknown>;
  };
  removeImage: (imageTag: string) => Promise<void>;
  removeVolume: (volumeName: string) => Promise<void>;
  // Existence probe for local install sources (rebuildImage fails actionably
  // when the recorded contextDir is gone instead of surfacing a docker error).
  directoryExists: (dir: string) => Promise<boolean>;
  // Remote inspection for git sources (track derivation + description).
  inspectRemote: (url: string) => Promise<InspectGitRemoteData>;
  vaultStore: Pick<VaultStore, 'deletePlugin'>;
  configStore: Pick<PluginConfigStore, 'deletePlugin'>;
}

export interface PluginUpdateResult {
  plugin: PluginMetadata;
  // Permissions the new version requests that the previous one didn't —
  // surfaced to the user post-update; they start denied.
  newPermissions: PluginPermissionRequest[];
  // TODO(secret-scope reporting): newly-declared secret config fields aren't
  // surfaced here yet, unlike newPermissions above. Wiring that through
  // requires a PluginConfigField[]-shaped sibling to newPermissions and a
  // frontend consumer for it (see Task 8's config UI) — deferred rather than
  // half-wiring an API shape nothing reads yet.
}

export class PluginInstaller {
  private deps: PluginInstallerDeps;

  constructor(
    private backend: PluginBuildBackend,
    deps?: Partial<PluginInstallerDeps>
  ) {
    const docker = new Docker();
    this.deps = {
      pluginManager: deps?.pluginManager ?? PluginManager.getInstance(),
      loader: deps?.loader ?? PluginRegistryLoader.getInstance(),
      trust: deps?.trust ?? TrustManager.getInstance(),
      inspectRemote: deps?.inspectRemote ?? inspectGitRemote,
      vaultStore: deps?.vaultStore ?? new VaultStore(),
      configStore: deps?.configStore ?? new PluginConfigStore(),
      directoryExists:
        deps?.directoryExists ??
        (async (dir: string) => {
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- Existence probe of a previously-recorded install source path
            return (await stat(dir)).isDirectory();
          } catch {
            return false;
          }
        }),
      removeImage:
        deps?.removeImage ??
        (async (imageTag: string) => {
          try {
            await docker.getImage(imageTag).remove({ force: true });
          } catch (error) {
            getLogger().warn(`⚠️ Could not remove image ${imageTag}: ${error}`);
          }
        }),
      removeVolume:
        deps?.removeVolume ??
        (async (volumeName: string) => {
          // A just-stopped ephemeral container (AutoRemove) can still hold the
          // volume for a moment, making removal 409 "in use" — retry briefly.
          for (let attempt = 0; attempt < 10; attempt++) {
            try {
              await docker.getVolume(volumeName).remove();
              return;
            } catch (error) {
              const statusCode = (error as { statusCode?: number })?.statusCode;
              // 404 = the plugin never executed, so no cache volume exists.
              if (statusCode === 404) return;
              if (statusCode === 409) {
                await sleep(500);
                continue;
              }
              getLogger().warn(
                `⚠️ Could not remove volume ${volumeName}: ${error}`
              );
              return;
            }
          }
          getLogger().warn(
            `⚠️ Could not remove volume ${volumeName}: still in use`
          );
        }),
    };
  }

  async install(source: PluginInstallSource): Promise<PluginMetadata> {
    source = await this.enrichGitSource(source);
    const { imageTag, metadata, commit } =
      await this.backend.buildPluginImage(source);
    if (source.kind === 'git' && commit) {
      source = { ...source, commit };
    }

    try {
      this.validateMetadata(metadata);

      if (await this.deps.loader.isBuiltin(metadata.id)) {
        throw new PluginError(
          `Cannot install '${metadata.id}': it shadows a built-in plugin`,
          ErrorCodes.PLUGIN_INSTALL_CONFLICT
        );
      }

      // Reject reinstalling over an already-installed id outright: the id is
      // self-declared by the candidate image's getInfo, and trust.json grants
      // are keyed by id. Silently overwriting the registry entry would let
      // brand-new, never-approved code inherit the prior grant (e.g.
      // hostWrite) without a fresh approval prompt. Caller must uninstall
      // first, which revokes trust before the id becomes available again.
      if (await this.deps.pluginManager.hasPlugin(metadata.id)) {
        throw new PluginError(
          `Plugin '${metadata.id}' is already installed; uninstall it first`,
          ErrorCodes.PLUGIN_INSTALL_CONFLICT
        );
      }

      // Persisted metadata points at the tag we actually built, so execution
      // resolves the right image regardless of what the plugin declared. The
      // install source is recorded alongside so a later update can prove it
      // comes from the same place before carrying grants over.
      const persisted: PluginMetadata = { ...metadata, baseImage: imageTag };
      await this.deps.pluginManager.addPlugin(persisted, source);
      getLogger().info(`✅ Installed plugin ${persisted.id} (${imageTag})`);
      return persisted;
    } catch (error) {
      // Any refusal past this point leaves a built image orphaned unless we
      // clean it up here.
      await this.deps.removeImage(imageTag).catch(() => {});
      throw error;
    }
  }

  // Update in place: rebuild from the plugin's recorded install source and
  // carry grants over. Safe only because identity is bound to the SOURCE, not
  // the self-declared id — a build from anywhere else is rejected, so foreign
  // code can never inherit an existing grant. Grants are clamped to the new
  // version's requested set; newly requested permissions start denied and are
  // reported back for the post-update permission prompt.
  async update(
    pluginId: string,
    source?: PluginInstallSource
  ): Promise<PluginUpdateResult> {
    if (await this.deps.loader.isBuiltin(pluginId)) {
      throw new PluginError(
        `Cannot update built-in plugin '${pluginId}'`,
        ErrorCodes.PLUGIN_UPDATE_INVALID
      );
    }
    if (!(await this.deps.pluginManager.hasPlugin(pluginId))) {
      throw new PluginError(
        `Plugin '${pluginId}' is not installed`,
        ErrorCodes.PLUGIN_NOT_FOUND,
        { pluginId }
      );
    }
    const previous = await this.deps.pluginManager.getPlugin(pluginId);
    const stored = await this.deps.pluginManager.getInstallSource(pluginId);
    if (!stored) {
      throw new PluginError(
        `Plugin '${pluginId}' has no recorded install source; uninstall and reinstall it instead`,
        ErrorCodes.PLUGIN_UPDATE_INVALID
      );
    }
    let effective = source ?? stored;
    this.assertSameSourceIdentity(pluginId, stored, effective);
    effective = await this.enrichGitSource(effective);

    const { imageTag, metadata, commit } =
      await this.backend.buildPluginImage(effective);
    if (effective.kind === 'git' && commit) {
      effective = { ...effective, commit };
    }
    try {
      this.validateMetadata(metadata);
      if (metadata.id !== pluginId) {
        throw new PluginError(
          `Update built a plugin with id '${metadata.id}', expected '${pluginId}'`,
          ErrorCodes.PLUGIN_UPDATE_INVALID
        );
      }

      const previousRequested = new Set(
        (previous.permissions ?? []).map((p) => p.id)
      );
      const requested = metadata.permissions ?? [];
      const requestedIds = new Set(requested.map((p) => p.id));
      const newPermissions = requested.filter(
        (p) => !previousRequested.has(p.id)
      );

      // Clamp grants to the new requested set: a permission the new version
      // no longer requests is revoked; new requests start denied. Secret
      // grants get the same treatment against the new manifest's declared
      // secret config-field keys — a key the new version no longer declares
      // as secret can't stay granted.
      const grant = await this.deps.trust.getGrant(pluginId);
      const declaredSecretKeys = new Set(
        (metadata.configFields ?? [])
          .filter((field) => field.secret)
          .map((field) => field.key)
      );
      const clamped: PluginPermissions = {
        hostWrite: grant.hostWrite && requestedIds.has('hostWrite'),
        net: grant.net && requestedIds.has('net'),
        secrets: grant.secrets.filter((key) => declaredSecretKeys.has(key)),
      };

      const persisted: PluginMetadata = { ...metadata, baseImage: imageTag };
      await this.deps.pluginManager.addPlugin(persisted, effective);
      await this.deps.trust.setTrust(
        pluginId,
        clamped.hostWrite || clamped.net || clamped.secrets.length > 0
          ? 'trusted'
          : 'untrusted',
        clamped
      );

      // Retagging already replaced the tag when the version is unchanged;
      // only remove the previous image when it lives under a different tag.
      if (previous.baseImage && previous.baseImage !== imageTag) {
        await this.deps.removeImage(previous.baseImage);
      }

      getLogger().info(
        `✅ Updated plugin ${pluginId} to ${persisted.version} (${imageTag})` +
          (newPermissions.length > 0
            ? `, requesting new permissions: ${newPermissions
                .map((p) => p.id)
                .join(', ')}`
            : '')
      );
      return { plugin: persisted, newPermissions };
    } catch (error) {
      // Never remove the tag the still-installed previous version points at.
      if (imageTag !== previous.baseImage) {
        await this.deps.removeImage(imageTag).catch(() => {});
      }
      throw error;
    }
  }

  // Rebuild the Docker image of an already-installed plugin whose image was
  // deleted (docker prune, manual rmi, ...). This is a REBUILD, not an
  // update: the registry entry and trust grants are the source of truth and
  // are never modified. Git sources rebuild from the PINNED commit recorded
  // at install time — never a floating ref, which may have moved to code the
  // user never approved — and the build must reproduce exactly the recorded
  // id/version (and therefore the recorded baseImage tag), or fail with an
  // actionable error telling the user to reinstall.
  async rebuildImage(pluginId: string): Promise<PluginMetadata> {
    if (await this.deps.loader.isBuiltin(pluginId)) {
      throw new PluginError(
        `Cannot rebuild built-in plugin '${pluginId}' from an install source; run \`npm run docker:build\` instead`,
        ErrorCodes.PLUGIN_REBUILD_FAILED,
        { pluginId }
      );
    }
    if (!(await this.deps.pluginManager.hasPlugin(pluginId))) {
      throw new PluginError(
        `Plugin '${pluginId}' is not installed`,
        ErrorCodes.PLUGIN_NOT_FOUND,
        { pluginId }
      );
    }
    const recorded = await this.deps.pluginManager.getPlugin(pluginId);
    const stored = await this.deps.pluginManager.getInstallSource(pluginId);
    if (!stored) {
      throw new PluginError(
        `Cannot rebuild plugin '${pluginId}': it has no recorded install source. Uninstall and reinstall it to restore its image.`,
        ErrorCodes.PLUGIN_REBUILD_FAILED,
        { pluginId }
      );
    }

    let buildSource: PluginInstallSource;
    if (stored.kind === 'git') {
      if (!stored.commit) {
        // A floating ref may have moved since install; silently rebuilding
        // from it would run code the user never approved under the old grant.
        throw new PluginError(
          `Cannot rebuild plugin '${pluginId}': its git install recorded no pinned commit (only the floating ref '${stored.ref ?? 'default branch'}'), so a rebuild could silently pick up different code. Uninstall and reinstall the plugin instead.`,
          ErrorCodes.PLUGIN_REBUILD_FAILED,
          { pluginId }
        );
      }
      buildSource = { kind: 'git', url: stored.url, ref: stored.commit };
    } else {
      if (!(await this.deps.directoryExists(stored.contextDir))) {
        throw new PluginError(
          `Cannot rebuild plugin '${pluginId}': its local install source '${stored.contextDir}' no longer exists. Uninstall and reinstall the plugin instead.`,
          ErrorCodes.PLUGIN_REBUILD_FAILED,
          { pluginId }
        );
      }
      buildSource = stored;
    }

    getLogger().info(
      `🔨 Rebuilding missing image ${recorded.baseImage} for plugin ${pluginId}`
    );
    const { imageTag, metadata } = await this.backend.buildPluginImage(
      buildSource
    );
    try {
      // The rebuilt image must be exactly what the registry already records —
      // a drifted local dir (or a commit that no longer builds the same
      // plugin) must not be silently substituted under the existing grant.
      if (
        metadata.id !== recorded.id ||
        metadata.version !== recorded.version ||
        imageTag !== recorded.baseImage
      ) {
        throw new PluginError(
          `Rebuild of plugin '${pluginId}' produced '${metadata.id}@${metadata.version}' (${imageTag}), but the registry records '${recorded.id}@${recorded.version}' (${recorded.baseImage}). The install source has drifted — uninstall and reinstall the plugin instead.`,
          ErrorCodes.PLUGIN_REBUILD_FAILED,
          { pluginId }
        );
      }
      getLogger().info(`✅ Rebuilt image ${imageTag} for plugin ${pluginId}`);
      return recorded;
    } catch (error) {
      // Don't leave a drifted image behind under a foreign tag; never remove
      // the tag the registry points at.
      if (imageTag !== recorded.baseImage) {
        await this.deps.removeImage(imageTag).catch(() => {});
      }
      throw error;
    }
  }

  // Fill in server-derived context for git sources: what the install tracks
  // (when the client didn't say) and the GitHub repo description. Best-effort
  // — an offline install still works, it just loses the extras.
  private async enrichGitSource(
    source: PluginInstallSource
  ): Promise<PluginInstallSource> {
    if (source.kind !== 'git') return source;
    let enriched = { ...source };
    try {
      const remote = await this.deps.inspectRemote(source.url);
      if (!enriched.track) {
        enriched.track = deriveTrack(enriched.ref, remote);
      }
      if (remote.github?.description) {
        enriched.description = remote.github.description;
      }
    } catch (error) {
      getLogger().warn(
        `Could not inspect ${source.url} while installing: ${error}`
      );
      if (!enriched.track) {
        // Offline fallback mirroring deriveTrack's shape rules.
        enriched.track = enriched.ref
          ? /^[0-9a-f]{40}$/i.test(enriched.ref)
            ? { mode: 'commit' }
            : { mode: 'branch', branch: enriched.ref }
          : { mode: 'branch', branch: 'main' };
      }
    }
    return enriched;
  }

  // Same-source check for updates. Git identity is the normalized URL (a ref
  // change is allowed — same repo); local identity is the exact context dir.
  private assertSameSourceIdentity(
    pluginId: string,
    stored: PluginInstallSource,
    candidate: PluginInstallSource
  ): void {
    const same =
      stored.kind === candidate.kind &&
      (stored.kind === 'git' && candidate.kind === 'git'
        ? normalizeRepoUrl(stored.url) === normalizeRepoUrl(candidate.url)
        : stored.kind === 'local' && candidate.kind === 'local'
          ? stored.contextDir === candidate.contextDir
          : false);
    if (!same) {
      throw new PluginError(
        `Update source does not match the source '${pluginId}' was installed from`,
        ErrorCodes.PLUGIN_UPDATE_INVALID
      );
    }
  }

  // Validate metadata self-declared by the candidate image before it's
  // trusted with a docker tag / registry entry / execution grant.
  private validateMetadata(metadata: PluginMetadata): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(metadata.id)) {
      throw new PluginError(
        `Invalid plugin id '${metadata.id}'`,
        ErrorCodes.PLUGIN_INSTALL_INVALID
      );
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(metadata.version)) {
      throw new PluginError(
        `Invalid plugin version '${metadata.version}' for '${metadata.id}'`,
        ErrorCodes.PLUGIN_INSTALL_INVALID
      );
    }
    const validTypes = Object.values(PluginType) as string[];
    if (!validTypes.includes(metadata.type)) {
      throw new PluginError(
        `Invalid plugin type '${metadata.type}' for '${metadata.id}'`,
        ErrorCodes.PLUGIN_INSTALL_INVALID
      );
    }
    if (metadata.type === PluginType.REPO_MANAGER) {
      throw new PluginError(
        `Cannot install '${metadata.id}': repo-manager plugins are native infrastructure and cannot be installed as third-party plugins`,
        ErrorCodes.PLUGIN_INSTALL_INVALID
      );
    }
    this.validatePermissionRequests(metadata);
    this.validateConfigSchema(metadata);
  }

  // The permission manifest is attacker-controlled input rendered in the
  // grant dialog: only known permission ids, no duplicates, and descriptions
  // that are short plain text.
  private validatePermissionRequests(metadata: PluginMetadata): void {
    const permissions = metadata.permissions;
    if (permissions === undefined) return;
    const invalid = (reason: string): PluginError =>
      new PluginError(
        `Invalid permission manifest for '${metadata.id}': ${reason}`,
        ErrorCodes.PLUGIN_INSTALL_INVALID
      );
    if (!Array.isArray(permissions)) {
      throw invalid('permissions must be an array');
    }
    if (permissions.length > PLUGIN_PERMISSION_IDS.length) {
      throw invalid('too many permission requests');
    }
    const seen = new Set<string>();
    for (const request of permissions) {
      if (typeof request !== 'object' || request === null) {
        throw invalid('each request must be an object');
      }
      if (!(PLUGIN_PERMISSION_IDS as readonly string[]).includes(request.id)) {
        throw invalid(`unknown permission '${String(request.id)}'`);
      }
      if (seen.has(request.id)) {
        throw invalid(`duplicate permission '${request.id}'`);
      }
      seen.add(request.id);
      if (
        typeof request.description !== 'string' ||
        request.description.trim().length === 0 ||
        request.description.length > 280
      ) {
        throw invalid(
          `permission '${request.id}' needs a description of 1-280 characters`
        );
      }
      // eslint-disable-next-line no-control-regex
      if (
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(request.description)
      ) {
        throw invalid(
          `permission '${request.id}' description contains control characters`
        );
      }
    }
  }

  // The config schema manifest is attacker-controlled input rendered as a
  // settings form: only known field types, no duplicate keys, and label /
  // description text that is short plain text (same discipline as
  // validatePermissionRequests above).
  private validateConfigSchema(metadata: PluginMetadata): void {
    const fields = metadata.configFields;
    if (fields === undefined) return;
    const invalid = (reason: string): PluginError =>
      new PluginError(
        `Invalid config schema for '${metadata.id}': ${reason}`,
        ErrorCodes.PLUGIN_INSTALL_INVALID
      );
    if (!Array.isArray(fields)) throw invalid('configFields must be an array');
    if (fields.length > MAX_CONFIG_FIELDS) throw invalid('too many config fields');
    const keyPattern = /^[a-z0-9][a-z0-9._-]*$/;
    // eslint-disable-next-line no-control-regex
    const controlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
    const types = new Set(['string', 'number', 'boolean', 'select']);
    const seen = new Set<string>();
    for (const field of fields) {
      if (typeof field !== 'object' || field === null) {
        throw invalid('each field must be an object');
      }
      const f = field as unknown as Record<string, unknown>;
      if (typeof f.key !== 'string' || !keyPattern.test(f.key)) {
        throw invalid(`invalid field key '${String(f.key)}'`);
      }
      if (typeof f.key === 'string' && f.key.length > 64) {
        const truncated = f.key.substring(0, 64);
        throw invalid(`field key '${truncated}' exceeds 64 characters`);
      }
      if (seen.has(f.key)) throw invalid(`duplicate field key '${f.key}'`);
      seen.add(f.key);
      if (typeof f.type !== 'string' || !types.has(f.type)) {
        throw invalid(`field '${f.key}' has unknown type '${String(f.type)}'`);
      }
      for (const textField of ['label', 'description'] as const) {
        const v = f[textField];
        if (v === undefined && textField === 'description') continue;
        if (typeof v !== 'string' || v.length === 0 || v.length > 280) {
          throw invalid(`field '${f.key}' has an invalid ${textField}`);
        }
        if (controlChars.test(v)) {
          throw invalid(
            `field '${f.key}' ${textField} contains control characters`
          );
        }
      }
      for (const boolField of ['secret', 'perChain', 'required'] as const) {
        if (f[boolField] !== undefined && typeof f[boolField] !== 'boolean') {
          throw invalid(`field '${f.key}' ${boolField} must be a boolean`);
        }
      }
      if (f.type === 'select') {
        if (!Array.isArray(f.options) || f.options.length === 0) {
          throw invalid(`select field '${f.key}' needs non-empty options`);
        }
        if (f.options.length > 64) {
          throw invalid(`select field '${f.key}' has too many options`);
        }
        for (const opt of f.options) {
          const o = opt as Record<string, unknown>;
          if (
            typeof o?.value !== 'string' ||
            typeof o?.label !== 'string' ||
            o.value.length === 0 ||
            o.value.length > 280 ||
            controlChars.test(o.value) ||
            o.label.length === 0 ||
            o.label.length > 280 ||
            controlChars.test(o.label)
          ) {
            throw invalid(`select field '${f.key}' has an invalid option`);
          }
        }
      } else if (f.options !== undefined) {
        throw invalid(`field '${f.key}' may not declare options`);
      }
    }
  }

  async uninstall(pluginId: string): Promise<void> {
    if (await this.deps.loader.isBuiltin(pluginId)) {
      throw new PluginError(
        `Cannot uninstall built-in plugin '${pluginId}'`,
        ErrorCodes.PLUGIN_INSTALL_CONFLICT
      );
    }
    // Revoke trust first (fail-closed): a trust entry surviving without a
    // plugin is dangerous (Critical #1 shows how it can be inherited by a
    // later reinstall), whereas a plugin surviving without a trust entry is
    // merely unusable until re-approved. Vault secrets and non-secret config
    // values are scoped to this plugin id too, so they're wiped alongside —
    // a later reinstall of the same id must not inherit either.
    await this.deps.trust.revoke(pluginId);
    await this.deps.vaultStore.deletePlugin(pluginId);
    await this.deps.configStore.deletePlugin(pluginId);

    let imageTag: string | undefined;
    if (await this.deps.pluginManager.hasPlugin(pluginId)) {
      imageTag = (await this.deps.pluginManager.getPlugin(pluginId)).baseImage;
    }
    await this.deps.pluginManager.removePlugin(pluginId);
    if (imageTag) {
      await this.deps.removeImage(imageTag);
    }
    // A fresh install of the same id must not inherit the old plugin's cache,
    // for the same reason it must not inherit its trust grant.
    await this.deps.removeVolume(pluginCacheVolumeName(pluginId));
  }
}
