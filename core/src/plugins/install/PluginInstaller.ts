import Docker from 'dockerode';
import type { PluginMetadata } from '@ignite/plugin-types/types';
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

    if (await this.deps.loader.isBuiltin(metadata.id)) {
      throw new PluginError(
        `Cannot install '${metadata.id}': it shadows a built-in plugin`,
        ErrorCodes.PLUGIN_INSTALL_CONFLICT
      );
    }

    // Persisted metadata points at the tag we actually built, so execution
    // resolves the right image regardless of what the plugin declared.
    const persisted: PluginMetadata = { ...metadata, baseImage: imageTag };
    await this.deps.pluginManager.addPlugin(persisted);
    getLogger().info(`✅ Installed plugin ${persisted.id} (${imageTag})`);
    return persisted;
  }

  async uninstall(pluginId: string): Promise<void> {
    if (await this.deps.loader.isBuiltin(pluginId)) {
      throw new PluginError(
        `Cannot uninstall built-in plugin '${pluginId}'`,
        ErrorCodes.PLUGIN_INSTALL_CONFLICT
      );
    }
    let imageTag: string | undefined;
    if (await this.deps.pluginManager.hasPlugin(pluginId)) {
      imageTag = (await this.deps.pluginManager.getPlugin(pluginId)).baseImage;
    }
    await this.deps.pluginManager.removePlugin(pluginId);
    await this.deps.trust.revoke(pluginId);
    if (imageTag) {
      await this.deps.removeImage(imageTag);
    }
  }
}
