// Install/uninstall handlers for third-party plugins. Session-protected.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IApiResponse, JobStartedData } from '@ignite/api';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import type { PluginUpdateResult } from '../../plugins/install/PluginInstaller.js';
import { createDefaultPluginInstaller } from '../../plugins/install/defaultInstaller.js';
import type { PluginInstallSource } from '../../plugins/install/types.js';
import { JobManager } from '../../jobs/JobManager.js';
import { RepoLifecycle } from '../../repos/RepoLifecycle.js';
import { ProfileManager } from '../../filesystem/ProfileManager.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';
import { getLogger } from '../../utils/logger.js';
import { sendBadRequest, sendCaughtError } from '../utils/errors.js';
import { DeploymentTypeService } from '../../deployments/DeploymentTypeService.js';
import { DeploymentHookService } from '../../deployments/DeploymentHookService.js';
import { ContractTypeService } from '../../deployments/ContractTypeService.js';

interface InstallerLike {
  install(source: PluginInstallSource): Promise<PluginMetadata>;
  update(
    pluginId: string,
    source?: PluginInstallSource
  ): Promise<PluginUpdateResult>;
  uninstall(pluginId: string): Promise<void>;
}

interface InstallHandlerOptions {
  // Local-path installs bypass the isolated git build, so they are only
  // allowed in development mode unless explicitly enabled (e.g. in tests).
  allowLocalSource: () => boolean;
}

// Subset of JobManager the handler depends on (tests pass fakes).
export interface InstallJobManagerLike {
  start: JobManager['start'];
}

export interface InstallHandlerDeps {
  jobs: InstallJobManagerLike;
  // Re-detect all repos after the plugin catalog changes so a freshly
  // installed compiler is picked up without a CLI restart.
  resweepRepos: () => Promise<void>;
  invalidateDeploymentTypes: () => void;
  invalidateDeploymentHooks: () => void;
  invalidateContractTypes: () => void;
}

async function resweepCurrentProfile(): Promise<void> {
  try {
    const profileManager = await ProfileManager.getInstance();
    await RepoLifecycle.getInstance().resweepProfile(
      profileManager.getCurrentProfile()
    );
  } catch (error) {
    // Detection staleness is not worth failing the install over.
    getLogger().warn(`Could not re-sweep repos after catalog change: ${error}`);
  }
}

export function createInstallHandlers(
  installer: InstallerLike,
  options: InstallHandlerOptions = {
    allowLocalSource: () => process.env.NODE_ENV === 'development',
  },
  deps?: Partial<InstallHandlerDeps>
) {
  const d: InstallHandlerDeps = {
    jobs: deps?.jobs ?? JobManager.getInstance(),
    resweepRepos: deps?.resweepRepos ?? resweepCurrentProfile,
    invalidateDeploymentTypes:
      deps?.invalidateDeploymentTypes ??
      (() => DeploymentTypeService.getInstance().invalidate()),
    invalidateDeploymentHooks:
      deps?.invalidateDeploymentHooks ??
      (() => DeploymentHookService.getInstance().invalidate()),
    invalidateContractTypes:
      deps?.invalidateContractTypes ??
      (() => ContractTypeService.getInstance().invalidate()),
  };

  return {
    installPlugin: async (
      request: FastifyRequest<{ Body: { source: PluginInstallSource } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      const { source } = request.body;
      // Local-path installs bypass the isolated git build; gate them
      // synchronously (400 fast) before ever creating a job.
      if (source.kind === 'local' && !options.allowLocalSource()) {
        return sendBadRequest(
          reply,
          ErrorCodes.PLUGIN_INSTALL_REJECTED,
          'Installing plugins from a local path is only available in development mode'
        );
      }

      const job = d.jobs.start('plugin.install', { source }, async () => {
        const plugin = await installer.install(source);
        await d.resweepRepos();
        d.invalidateDeploymentTypes();
        d.invalidateDeploymentHooks();
        d.invalidateContractTypes();
        return { plugin };
      });

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    updatePlugin: async (
      request: FastifyRequest<{
        Params: { pluginId: string };
        Body: { source?: PluginInstallSource };
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      const { pluginId } = request.params;
      const source = request.body?.source;
      // Same dev-mode gate as install: an explicit local source is checked
      // here; a stored local source is re-checked inside the job runner once
      // it's loaded (the installer rejects mismatched sources anyway).
      if (source?.kind === 'local' && !options.allowLocalSource()) {
        return sendBadRequest(
          reply,
          ErrorCodes.PLUGIN_INSTALL_REJECTED,
          'Updating plugins from a local path is only available in development mode'
        );
      }

      const job = d.jobs.start(
        'plugin.update',
        { pluginId, ...(source ? { source } : {}) },
        async () => {
          const result = await installer.update(pluginId, source);
          await d.resweepRepos();
          d.invalidateDeploymentTypes();
          d.invalidateDeploymentHooks();
        d.invalidateContractTypes();
          return result;
        }
      );

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    uninstallPlugin: async (
      request: FastifyRequest<{ Params: { pluginId: string } }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await installer.uninstall(request.params.pluginId);
        await d.resweepRepos();
        d.invalidateDeploymentTypes();
        d.invalidateDeploymentHooks();
        d.invalidateContractTypes();
        return reply.status(204).send();
      } catch (error) {
        if (
          error instanceof PluginError &&
          error.code === ErrorCodes.PLUGIN_INSTALL_CONFLICT
        ) {
          return sendBadRequest(
            reply,
            'PLUGIN_UNINSTALL_REJECTED',
            error.message
          ) as unknown as null;
        }
        return sendCaughtError(
          reply,
          error,
          'PLUGIN_UNINSTALL_ERROR',
          'Failed to uninstall plugin'
        ) as unknown as null;
      }
    },
  };
}

// Production wiring: route local sources to the host builder, git sources to
// the isolated builder (shared with the startup image validator and the
// executor's lazy rebuild path).
export const installHandlers = createInstallHandlers(
  createDefaultPluginInstaller()
);
