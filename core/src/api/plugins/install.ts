// Install/uninstall handlers for third-party plugins. Session-protected.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IApiResponse, InstallPluginData } from '@ignite/api';
import type { PluginMetadata } from '@ignite/plugin-types/types';
import { PluginInstaller } from '../../plugins/install/PluginInstaller.js';
import { LocalFolderBuildBackend } from '../../plugins/install/LocalFolderBuildBackend.js';
import type { PluginInstallSource } from '../../plugins/install/types.js';
import { sendBadRequest, sendCaughtError } from '../utils/errors.js';

interface InstallerLike {
  install(source: PluginInstallSource): Promise<PluginMetadata>;
  uninstall(pluginId: string): Promise<void>;
}

export function createInstallHandlers(installer: InstallerLike) {
  return {
    installPlugin: async (
      request: FastifyRequest<{ Body: { source: PluginInstallSource } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<InstallPluginData>> => {
      try {
        const plugin = await installer.install(request.body.source);
        return reply.status(200).send({ data: { plugin } });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/built-in|shadow/i.test(msg)) {
          return sendBadRequest(reply, 'PLUGIN_INSTALL_REJECTED', msg);
        }
        return sendCaughtError(
          reply,
          error,
          'PLUGIN_INSTALL_ERROR',
          'Failed to install plugin'
        );
      }
    },

    uninstallPlugin: async (
      request: FastifyRequest<{ Params: { pluginId: string } }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await installer.uninstall(request.params.pluginId);
        return reply.status(204).send();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/built-in/i.test(msg)) {
          return sendBadRequest(reply, 'PLUGIN_UNINSTALL_REJECTED', msg) as unknown as null;
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

// Production wiring: local-folder backend reads contextDir + dockerfile straight
// from the request source — no path guessing.
export const installHandlers = createInstallHandlers(
  new PluginInstaller(new LocalFolderBuildBackend())
);
