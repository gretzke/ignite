import Docker from 'dockerode';
import { PluginRegistryLoader } from '../../assets/PluginRegistryLoader.js';
import { getLogger } from '../../utils/logger.js';

// Validates that every plugin baseImage exists locally and was built from the
// same Dockerfiles recorded in the plugin registry (ignite.dockerfileHash label).
// Logs actionable errors/warnings instead of throwing — a missing image only
// matters once its plugin is actually used.
export async function validatePluginImages(): Promise<void> {
  const docker = new Docker();
  const registry = await PluginRegistryLoader.getInstance().getAllPlugins();
  const seen = new Set<string>();

  for (const config of Object.values(registry)) {
    const { baseImage, imageHash } = config.metadata;
    if (!baseImage || seen.has(baseImage)) {
      continue;
    }
    seen.add(baseImage);

    try {
      const info = await docker.getImage(baseImage).inspect();
      if (!imageHash) {
        // Installed third-party images have no registry-generated hash; only
        // existence is validated for them.
        continue;
      }
      const builtHash = info.Config?.Labels?.['ignite.dockerfileHash'];
      if (imageHash && builtHash !== imageHash) {
        getLogger().warn(
          `⚠️ Docker image ${baseImage} is stale (built from an older Dockerfile). ` +
            'Run `npm run docker:build` to rebuild plugin images.'
        );
      }
    } catch {
      getLogger().error(
        `❌ Docker image ${baseImage} not found. ` +
          'Run `npm run docker:build` before using this plugin.'
      );
    }
  }
}
