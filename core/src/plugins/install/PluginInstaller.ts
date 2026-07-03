import Docker from 'dockerode';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginManager } from '../../filesystem/PluginManager.js';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { TrustManager } from '../trust/TrustManager.js';
import { getLogger } from '../../utils/logger.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';
import type { PluginBuildBackend, PluginInstallSource } from './types.js';

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface PluginInstallerDeps {
  pluginManager: Pick<
    PluginManager,
    'addPlugin' | 'removePlugin' | 'hasPlugin' | 'getPlugin'
  >;
  loader: Pick<PluginRegistryLoader, 'isBuiltin'>;
  trust: { revoke: (pluginId: string) => Promise<void> };
  removeImage: (imageTag: string) => Promise<void>;
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
      removeImage:
        deps?.removeImage ??
        (async (imageTag: string) => {
          try {
            await docker.getImage(imageTag).remove({ force: true });
          } catch (error) {
            getLogger().warn(`⚠️ Could not remove image ${imageTag}: ${error}`);
          }
        }),
    };
  }

  async install(source: PluginInstallSource): Promise<PluginMetadata> {
    const { imageTag, metadata } = await this.backend.buildPluginImage(source);

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
      // resolves the right image regardless of what the plugin declared.
      const persisted: PluginMetadata = { ...metadata, baseImage: imageTag };
      await this.deps.pluginManager.addPlugin(persisted);
      getLogger().info(`✅ Installed plugin ${persisted.id} (${imageTag})`);
      return persisted;
    } catch (error) {
      // Any refusal past this point leaves a built image orphaned unless we
      // clean it up here.
      await this.deps.removeImage(imageTag).catch(() => {});
      throw error;
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
    // merely unusable until re-approved.
    await this.deps.trust.revoke(pluginId);

    let imageTag: string | undefined;
    if (await this.deps.pluginManager.hasPlugin(pluginId)) {
      imageTag = (await this.deps.pluginManager.getPlugin(pluginId)).baseImage;
    }
    await this.deps.pluginManager.removePlugin(pluginId);
    if (imageTag) {
      await this.deps.removeImage(imageTag);
    }
  }
}
