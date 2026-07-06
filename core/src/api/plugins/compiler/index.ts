// Compiler plugin route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiResponse,
  DetectionResult,
  DetectResponse,
  JobStartedData,
  CompilerOperationRequest,
  ArtifactListResult,
  GetArtifactDataRequest,
  ArtifactData,
} from '@ignite/api';
import type { PathOptions } from '@ignite/plugin-types';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginExecutor } from '../../../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../../../assets/PluginRegistryLoader.js';
import { JobManager } from '../../../jobs/JobManager.js';
import { RepoService } from '../../../repos/RepoService.js';
import { getLogger } from '../../../utils/logger.js';
import { ErrorCodes } from '../../../types/errors.js';
import {
  sendPluginError,
  sendCaughtError,
  sendBadRequest,
} from '../../utils/errors.js';

// Subsets of the real singletons the handlers depend on — narrow enough that
// tests can inject fakes without implementing the full classes.
export interface CompilerExecutorLike {
  execute: PluginExecutor['execute'];
}

export interface CompilerRegistryLoaderLike {
  getPluginConfig: PluginRegistryLoader['getPluginConfig'];
  getPluginsByType: PluginRegistryLoader['getPluginsByType'];
}

export interface CompilerJobManagerLike {
  start: JobManager['start'];
}

export interface CompilerRepoServiceLike {
  resolveExistingWorkspacePath: RepoService['resolveExistingWorkspacePath'];
}

export interface CompilerHandlerDeps {
  jobs: CompilerJobManagerLike;
  executor: CompilerExecutorLike;
  registryLoader: CompilerRegistryLoaderLike;
  repos: CompilerRepoServiceLike;
}

export function createCompilerHandlers(deps?: Partial<CompilerHandlerDeps>) {
  const d: CompilerHandlerDeps = {
    jobs: deps?.jobs ?? JobManager.getInstance(),
    executor: deps?.executor ?? PluginExecutor.getInstance(),
    registryLoader: deps?.registryLoader ?? PluginRegistryLoader.getInstance(),
    repos: deps?.repos ?? RepoService.getInstance(),
  };

  // Returns true (and has already sent a 400) if pluginId does not resolve
  // to a compiler plugin, otherwise false.
  //
  // NOTE: this deliberately returns a boolean, not the FastifyReply itself.
  // FastifyReply implements a `.then()` for Fastify's own dispatch
  // machinery; returning it through this intermediate `async function` and
  // then `await`-ing the call site collapses the resolved value to
  // `undefined` (standard thenable-unwrapping), silently defeating an
  // `if (rejection) return rejection;` early-return check. Top-level route
  // handlers can safely `return reply` directly (Fastify's dispatcher
  // special-cases that), but nested helpers cannot.
  async function rejectNonCompilerPlugin(
    reply: FastifyReply,
    pluginId: string
  ): Promise<boolean> {
    try {
      const config = await d.registryLoader.getPluginConfig(pluginId);
      if (config.metadata.type !== PluginType.COMPILER) {
        sendBadRequest(
          reply,
          ErrorCodes.NOT_A_COMPILER_PLUGIN,
          `Plugin ${pluginId} is not a compiler plugin`
        );
        return true;
      }
      return false;
    } catch {
      sendBadRequest(
        reply,
        ErrorCodes.UNKNOWN_PLUGIN,
        `Unknown plugin: ${pluginId}`
      );
      return true;
    }
  }

  // Resolves pathOrUrl to the host workspace dir the ephemeral compiler
  // container will bind-mount, requiring it to EXIST (a missing dir would be
  // silently auto-created by the Docker daemon). Same "return sentinel,
  // don't return the FastifyReply" reasoning as rejectNonCompilerPlugin
  // above: a nested async helper can't safely propagate an early
  // `return reply` through await. Failure here (unresolvable identity,
  // uninitialized repo) is a client-fixable 400, not a 500.
  async function resolveWorkspaceOr400(
    reply: FastifyReply,
    pathOrUrl: string
  ): Promise<string | null> {
    try {
      return await d.repos.resolveExistingWorkspacePath(pathOrUrl);
    } catch (error) {
      sendBadRequest(
        reply,
        ErrorCodes.INIT_ERROR,
        `Failed to resolve workspace for repository '${pathOrUrl}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  return {
    detect: async (
      request: FastifyRequest<{
        Body: PathOptions;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      // Get hostPath from request body or fall back to environment/cwd
      const hostPath =
        request.body.pathOrUrl ||
        process.env.IGNITE_WORKSPACE_PATH ||
        process.cwd();

      // Resolve once, outside the job runner's per-plugin fan-out — every
      // compiler plugin binds the same workspace.
      const workspacePath = await resolveWorkspaceOr400(reply, hostPath);
      if (workspacePath === null) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const job = d.jobs.start(
        'compiler.detect',
        { pathOrUrl: hostPath },
        async (ctx): Promise<DetectResponse> => {
          const compilerPlugins = await d.registryLoader.getPluginsByType(
            PluginType.COMPILER
          );

          // Zero available compilers is a broken installation (built-in
          // plugins ship with the binary), not an empty detection result.
          // Failing here is what surfaces a missing/corrupt plugin catalog
          // to the user instead of rendering every repo as "no framework".
          if (compilerPlugins.length === 0) {
            throw Object.assign(
              new Error(
                'No compiler plugins are available — the plugin catalog is missing or corrupt. Reinstall Ignite (or in development, run the plugin build).'
              ),
              { code: ErrorCodes.NO_COMPILER_PLUGINS }
            );
          }

          // Run detection on all compiler plugins in parallel; a single
          // broken plugin must not fail detection for the others
          const detectionPromises = compilerPlugins.map(
            async (pluginConfig) => {
              try {
                const result = await d.executor.execute(
                  pluginConfig.metadata.id,
                  'detect',
                  { pathOrUrl: hostPath },
                  {
                    onOutput: (t) => ctx.log(t),
                    workspacePath,
                    signal: ctx.signal,
                  }
                );

                if (
                  result.success &&
                  (result.data as DetectionResult).detected
                ) {
                  return {
                    id: pluginConfig.metadata.id,
                    name: pluginConfig.metadata.name,
                  };
                }
                return null;
              } catch (error) {
                getLogger().error(
                  `Failed to detect ${pluginConfig.metadata.id}: ${error}`
                );
                return null;
              }
            }
          );

          const detectionResults = await Promise.all(detectionPromises);

          const frameworks = detectionResults.filter(
            (framework): framework is { id: string; name: string } =>
              framework !== null
          );

          return { frameworks };
        }
      );

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    install: async (
      request: FastifyRequest<{
        Body: CompilerOperationRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      const { pathOrUrl, pluginId } = request.body;

      if (await rejectNonCompilerPlugin(reply, pluginId)) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const workspacePath = await resolveWorkspaceOr400(reply, pathOrUrl);
      if (workspacePath === null) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const job = d.jobs.start(
        'compiler.install',
        { pathOrUrl, pluginId },
        async (ctx): Promise<null> => {
          const result = await d.executor.execute(
            pluginId,
            'install',
            { pathOrUrl },
            { onOutput: (t) => ctx.log(t), workspacePath, signal: ctx.signal }
          );

          if (!result.success) {
            throw Object.assign(
              new Error(result.error?.message ?? 'Installation failed'),
              {
                code: result.error?.code ?? ErrorCodes.INSTALL_FAILED,
                details: result.error?.details,
              }
            );
          }

          return null;
        }
      );

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    compile: async (
      request: FastifyRequest<{
        Body: CompilerOperationRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      const { pathOrUrl, pluginId } = request.body;

      if (await rejectNonCompilerPlugin(reply, pluginId)) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const workspacePath = await resolveWorkspaceOr400(reply, pathOrUrl);
      if (workspacePath === null) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const job = d.jobs.start(
        'compiler.compile',
        { pathOrUrl, pluginId },
        async (ctx): Promise<null> => {
          const result = await d.executor.execute(
            pluginId,
            'compile',
            { pathOrUrl },
            { onOutput: (t) => ctx.log(t), workspacePath, signal: ctx.signal }
          );

          if (!result.success) {
            throw Object.assign(
              new Error(result.error?.message ?? 'Compilation failed'),
              {
                code: result.error?.code ?? ErrorCodes.COMPILE_FAILED,
                details: result.error?.details,
              }
            );
          }

          return null;
        }
      );

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    listArtifacts: async (
      request: FastifyRequest<{
        Body: CompilerOperationRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ArtifactListResult>> => {
      try {
        const { pluginId, pathOrUrl } = request.body;

        if (await rejectNonCompilerPlugin(reply, pluginId)) {
          return reply as unknown as IApiResponse<ArtifactListResult>;
        }

        // Get hostPath from request body or fall back to environment/cwd
        const hostPath =
          pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

        const workspacePath = await resolveWorkspaceOr400(reply, hostPath);
        if (workspacePath === null) {
          return reply as unknown as IApiResponse<ArtifactListResult>;
        }

        const result = await d.executor.execute(
          pluginId,
          'listArtifacts',
          { pathOrUrl: hostPath },
          { workspacePath }
        );

        if (!result.success) {
          return sendPluginError(
            reply,
            result,
            ErrorCodes.ARTIFACT_LISTING_ERROR,
            'Failed to list artifacts'
          );
        }

        const body: IApiResponse<ArtifactListResult> = {
          data: result.data as ArtifactListResult,
        };
        return reply.status(200).send(body);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.ARTIFACT_LISTING_ERROR,
          'Failed to list artifacts'
        );
      }
    },

    getArtifactData: async (
      request: FastifyRequest<{
        Body: GetArtifactDataRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ArtifactData>> => {
      try {
        const { pluginId, pathOrUrl, artifactPath } = request.body;

        if (await rejectNonCompilerPlugin(reply, pluginId)) {
          return reply as unknown as IApiResponse<ArtifactData>;
        }

        // Get hostPath from request body or fall back to environment/cwd
        const hostPath =
          pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

        const workspacePath = await resolveWorkspaceOr400(reply, hostPath);
        if (workspacePath === null) {
          return reply as unknown as IApiResponse<ArtifactData>;
        }

        const result = await d.executor.execute(
          pluginId,
          'getArtifactData',
          { pathOrUrl: hostPath, artifactPath },
          { workspacePath }
        );

        if (!result.success) {
          const notFound =
            !result.success &&
            (result.error?.code === ErrorCodes.ARTIFACT_NOT_FOUND ||
              result.error?.code === ErrorCodes.ARTIFACT_PARSE_ERROR);
          return sendPluginError(
            reply,
            result,
            ErrorCodes.ARTIFACT_DATA_ERROR,
            'Failed to get artifact data',
            notFound ? 404 : 500
          );
        }

        const body: IApiResponse<ArtifactData> = {
          data: result.data as ArtifactData,
        };
        return reply.status(200).send(body);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.ARTIFACT_DATA_ERROR,
          'Failed to get artifact data'
        );
      }
    },
  };
}

// Production wiring: same exported name as before, so route registration in
// core/src/api/index.ts is untouched.
export const compilerHandlers = createCompilerHandlers();
