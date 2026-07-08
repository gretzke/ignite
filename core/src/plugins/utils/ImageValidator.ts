import Docker from 'dockerode';
import {
  PluginRegistryLoader,
  type PluginConfig,
} from '../../assets/PluginRegistryLoader.js';
import { JobManager } from '../../jobs/JobManager.js';
import { createDefaultPluginInstaller } from '../install/defaultInstaller.js';
import { getLogger } from '../../utils/logger.js';

// Injectable dependencies (tests pass fakes; production uses real singletons).
export interface ImageValidatorDeps {
  getAllPlugins: () => Promise<Record<string, PluginConfig>>;
  // Inspect a local image; resolves with its labels, rejects when missing.
  inspectImage: (
    tag: string
  ) => Promise<{ labels?: Record<string, string> }>;
  jobs: Pick<JobManager, 'start'>;
  // Rebuild an installed plugin's image from its recorded pinned source.
  rebuildImage: (pluginId: string) => Promise<unknown>;
}

// Validates that every plugin baseImage exists locally and was built from the
// same Dockerfiles recorded in the plugin registry (ignite.dockerfileHash label).
// Built-in images log actionable errors/warnings (they are rebuilt via
// `npm run docker:build`); a missing INSTALLED image instead enqueues a
// plugin.rebuild job that restores it from the plugin's recorded install
// source — without it the plugin would stay bricked until a manual reinstall.
export async function validatePluginImages(
  deps?: Partial<ImageValidatorDeps>
): Promise<void> {
  const docker = deps?.inspectImage ? undefined : new Docker();
  const d: ImageValidatorDeps = {
    getAllPlugins:
      deps?.getAllPlugins ??
      (() => PluginRegistryLoader.getInstance().getAllPlugins()),
    inspectImage:
      deps?.inspectImage ??
      (async (tag: string) => {
        const info = await docker!.getImage(tag).inspect();
        return { labels: info.Config?.Labels };
      }),
    jobs: deps?.jobs ?? JobManager.getInstance(),
    rebuildImage:
      deps?.rebuildImage ??
      ((pluginId: string) =>
        createDefaultPluginInstaller().rebuildImage(pluginId)),
  };

  const registry = await d.getAllPlugins();
  const seen = new Set<string>();

  for (const config of Object.values(registry)) {
    const { baseImage, imageHash } = config.metadata;
    if (!baseImage || seen.has(baseImage)) {
      continue;
    }
    seen.add(baseImage);

    try {
      const info = await d.inspectImage(baseImage);
      if (!imageHash) {
        // Installed third-party images have no registry-generated hash; only
        // existence is validated for them.
        continue;
      }
      const builtHash = info.labels?.['ignite.dockerfileHash'];
      if (imageHash && builtHash !== imageHash) {
        getLogger().warn(
          `⚠️ Docker image ${baseImage} is stale (built from an older Dockerfile). ` +
            'Run `npm run docker:build` to rebuild plugin images.'
        );
      }
    } catch {
      if (config.origin === 'installed') {
        enqueueRebuild(d, config.metadata.id, baseImage);
        continue;
      }
      getLogger().error(
        `❌ Docker image ${baseImage} not found. ` +
          'Run `npm run docker:build` before using this plugin.'
      );
    }
  }
}

// One plugin.rebuild job per missing installed image. The job's event log is
// the user-visible progress surface (jobs WS channel); a failed rebuild keeps
// a single actionable error line in the core log.
function enqueueRebuild(
  deps: ImageValidatorDeps,
  pluginId: string,
  baseImage: string
): void {
  const job = deps.jobs.start(
    'plugin.rebuild',
    { pluginId, image: baseImage },
    async (ctx) => {
      ctx.log(`Rebuilding missing image ${baseImage} for plugin ${pluginId}`);
      try {
        await deps.rebuildImage(pluginId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getLogger().error(
          `❌ Could not rebuild missing image ${baseImage} for plugin '${pluginId}': ${message}`
        );
        throw error;
      }
      ctx.log(`Rebuilt ${baseImage}`);
      return { pluginId, image: baseImage };
    }
  );
  getLogger().warn(
    `⚠️ Docker image ${baseImage} for installed plugin '${pluginId}' is missing; rebuild job ${job.id} started`
  );
}
