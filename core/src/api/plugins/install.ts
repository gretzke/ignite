// Install/uninstall handlers for third-party plugins. Session-protected.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IApiResponse, JobStartedData } from '@ignite/api';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { PluginInstaller } from '../../plugins/install/PluginInstaller.js';
import { LocalFolderBuildBackend } from '../../plugins/install/LocalFolderBuildBackend.js';
import { GitSourceBuildBackend } from '../../plugins/install/GitSourceBuildBackend.js';
import { RoutingBuildBackend } from '../../plugins/install/RoutingBuildBackend.js';
import type { PluginInstallSource } from '../../plugins/install/types.js';
import { JobManager } from '../../jobs/JobManager.js';
import { PluginError, ErrorCodes } from '../../types/errors.js';
import { sendBadRequest, sendCaughtError } from '../utils/errors.js';

interface InstallerLike {
  install(source: PluginInstallSource): Promise<PluginMetadata>;
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
        return { plugin };
      });

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    uninstallPlugin: async (
      request: FastifyRequest<{ Params: { pluginId: string } }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await installer.uninstall(request.params.pluginId);
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
// the isolated builder.
export const installHandlers = createInstallHandlers(
  new PluginInstaller(
    new RoutingBuildBackend(
      new LocalFolderBuildBackend(),
      new GitSourceBuildBackend()
    )
  )
);
