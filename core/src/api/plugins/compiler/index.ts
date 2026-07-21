// Compiler plugin route handlers
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiResponse,
  DetectionResult,
  DetectResponse,
  JobStartedData,
  CompilerOperationRequest,
  ArtifactListServeResult,
  GetArtifactDataRequest,
  ArtifactData,
  ContractSource,
  ContractSourcePin,
} from '@ignite/api';
import type { PathOptions } from '@ignite/plugin-types';
import type { VerificationBundleData } from '@ignite/plugin-types/base/compiler';
import type { ArtifactListResult } from '@ignite/plugin-types/base/compiler';
import { PluginType } from '@ignite/plugin-types/types';
import { PluginExecutor } from '../../../plugins/containers/PluginExecutor.js';
import { PluginRegistryLoader } from '../../../assets/PluginRegistryLoader.js';
import { JobManager } from '../../../jobs/JobManager.js';
import { RepoService } from '../../../repos/RepoService.js';
import { resolveContractWorkspace } from '../../../repos/workspaceResolver.js';
import { VersionStore } from '../../../repos/VersionStore.js';
import { ProfileManager } from '../../../filesystem/ProfileManager.js';
import { getLogger } from '../../../utils/logger.js';
import { ErrorCodes } from '../../../types/errors.js';
import { IgniteError } from '../../../types/errors.js';
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
  ensureVersion: RepoService['ensureVersion'];
  assertPinnedIntegrity?: RepoService['assertPinnedIntegrity'];
  withRepoLifecycleLock: RepoService['withRepoLifecycleLock'];
  withVersionMaterialized: RepoService['withVersionMaterialized'];
}

export interface CompilerHandlerDeps {
  jobs: CompilerJobManagerLike;
  executor: CompilerExecutorLike;
  registryLoader: CompilerRegistryLoaderLike;
  repos: CompilerRepoServiceLike;
  versionStore: Pick<VersionStore, 'isCachePath' | 'checkoutPath'>;
}

type MutableCompilerOperationRequest = CompilerOperationRequest & {
  pin?: ContractSourcePin;
};

// Shared compiler-artifact operation used by both the HTTP handler and the
// deployment freeze service. Keeping the plugin invocation here prevents the
// launch path from subtly diverging from `/artifacts/data`.
export async function getCompilerArtifactData(
  deps: Pick<CompilerHandlerDeps, 'executor' | 'registryLoader' | 'repos'>,
  input: { contract: ContractSource; profileId: string }
): Promise<ArtifactData> {
  const { contract } = input;
  // Contract-type sources are resolved by ContractTypeService before this
  // compiler boundary. Reaching it indicates an internal routing bug.
  if (contract.origin === 'contract-type') throw new IgniteError('Contract-type source reached the compiler boundary', 'CONTRACT_TYPE_OP_FAILED');
  let config;
  try {
    config = await deps.registryLoader.getPluginConfig(contract.frameworkId);
  } catch {
    throw Object.assign(new Error(`Unknown plugin: ${contract.frameworkId}`), {
      code: ErrorCodes.UNKNOWN_PLUGIN,
    });
  }
  if (!config.metadata.types.includes(PluginType.COMPILER)) {
    throw Object.assign(
      new Error(`Plugin ${contract.frameworkId} is not a compiler plugin`),
      { code: ErrorCodes.NOT_A_COMPILER_PLUGIN }
    );
  }
  const execute = (workspacePath: string) => deps.executor.execute(
    contract.frameworkId, 'getArtifactData',
    { pathOrUrl: contract.repoPathOrUrl, artifactPath: contract.artifactPath }, { workspacePath }
  );
  let result;
  try {
    result = contract.pin
      ? await deps.repos.withVersionMaterialized(input.profileId, contract.pin.url, contract.pin.commit, { ref: contract.pin.ref }, ({ checkout }) => execute(checkout))
      : await resolveContractWorkspace(contract, input.profileId, { verifyIntegrity: true }, { repos: deps.repos, versionStore: new VersionStore() }).then(execute);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw Object.assign(new Error(error instanceof Error ? error.message : 'Failed to resolve workspace'), { code: ErrorCodes.INIT_ERROR });
  }
  if (!result.success) {
    throw Object.assign(new Error('Failed to get artifact data'), {
      code: result.error?.code ?? ErrorCodes.ARTIFACT_DATA_ERROR,
    });
  }
  return result.data as ArtifactData;
}

// Shared compiler-bundle operation used by freeze-time capture and the
// after-the-fact verification flow. It intentionally mirrors artifact data:
// both resolve the workspace once and execute through the same compiler
// plugin boundary.
export async function getCompilerVerificationBundle(
  deps: Pick<CompilerHandlerDeps, 'executor' | 'registryLoader' | 'repos'>,
  input: { contract: ContractSource; profileId: string }
): Promise<VerificationBundleData> {
  const { contract } = input;
  // Contract-type sources are resolved by ContractTypeService before this
  // compiler boundary. Reaching it indicates an internal routing bug.
  if (contract.origin === 'contract-type') throw new IgniteError('Contract-type source reached the compiler boundary', 'CONTRACT_TYPE_OP_FAILED');
  let config;
  try {
    config = await deps.registryLoader.getPluginConfig(contract.frameworkId);
  } catch {
    throw Object.assign(new Error(`Unknown plugin: ${contract.frameworkId}`), {
      code: ErrorCodes.UNKNOWN_PLUGIN,
    });
  }
  if (!config.metadata.types.includes(PluginType.COMPILER)) {
    throw Object.assign(
      new Error(`Plugin ${contract.frameworkId} is not a compiler plugin`),
      { code: ErrorCodes.NOT_A_COMPILER_PLUGIN }
    );
  }
  const execute = (workspacePath: string) => deps.executor.execute(
    contract.frameworkId, 'getVerificationBundle',
    { pathOrUrl: contract.repoPathOrUrl, artifactPath: contract.artifactPath }, { workspacePath }
  );
  let result;
  try {
    result = contract.pin
      ? await deps.repos.withVersionMaterialized(input.profileId, contract.pin.url, contract.pin.commit, { ref: contract.pin.ref }, ({ checkout }) => execute(checkout))
      : await resolveContractWorkspace(contract, input.profileId, { verifyIntegrity: true }, { repos: deps.repos, versionStore: new VersionStore() }).then(execute);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error;
    throw Object.assign(new Error(error instanceof Error ? error.message : 'Failed to resolve workspace'), { code: ErrorCodes.INIT_ERROR });
  }
  if (!result.success) {
    throw Object.assign(new Error('Failed to get verification bundle'), {
      code: result.error?.code ?? ErrorCodes.ARTIFACT_DATA_ERROR,
    });
  }
  return result.data as VerificationBundleData;
}

export function createCompilerHandlers(deps?: Partial<CompilerHandlerDeps>) {
  const d: CompilerHandlerDeps = {
    jobs: deps?.jobs ?? JobManager.getInstance(),
    executor: deps?.executor ?? PluginExecutor.getInstance(),
    registryLoader: deps?.registryLoader ?? PluginRegistryLoader.getInstance(),
    repos: deps?.repos ?? RepoService.getInstance(),
    versionStore: deps?.versionStore ?? new VersionStore(),
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
      if (!config.metadata.types.includes(PluginType.COMPILER)) {
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

  async function resolveMutableWorkspaceOr400(
    reply: FastifyReply,
    request: MutableCompilerOperationRequest
  ): Promise<{
    workspacePath: string;
    pin?: ContractSourcePin;
    profileId?: string;
  } | null> {
    let workspacePath: string;
    let profileId: string | undefined;
    try {
      if (request.pin) {
        profileId = (await ProfileManager.getInstance()).getCurrentProfile();
        workspacePath = await resolveContractWorkspace(
          {
            id: 'compiler-operation',
            repoPathOrUrl: request.pathOrUrl,
            frameworkId: request.pluginId,
            artifactPath: '',
            contractName: '',
            sourcePath: '',
            pin: request.pin,
          },
          profileId,
          {},
          { repos: d.repos, versionStore: d.versionStore }
        );
      } else {
        workspacePath = await d.repos.resolveExistingWorkspacePath(request.pathOrUrl);
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : ErrorCodes.INIT_ERROR;
      sendBadRequest(
        reply,
        code as (typeof ErrorCodes)[keyof typeof ErrorCodes],
        error instanceof Error ? error.message : 'Failed to resolve workspace'
      );
      return null;
    }
    if (!request.pin && d.versionStore.isCachePath(workspacePath)) {
      sendBadRequest(
        reply,
        ErrorCodes.VERSION_WORKSPACE_PIN_REQUIRED,
        'Version cache workspaces must be addressed by a version pin'
      );
      return null;
    }
    return { workspacePath, pin: request.pin, profileId };
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

      const resolved = await resolveMutableWorkspaceOr400(reply, request.body);
      if (resolved === null) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const job = d.jobs.start(
        'compiler.install',
        { pathOrUrl, pluginId, ...(resolved.pin ? { pin: resolved.pin } : {}) },
        async (ctx): Promise<null> => {
          const execute = (workspacePath: string) => d.executor.execute(
            pluginId, 'install', { pathOrUrl },
            { onOutput: (t) => ctx.log(t), workspacePath, signal: ctx.signal }
          );
          const result = resolved.pin
            ? await d.repos.withVersionMaterialized(
              resolved.profileId!,
              resolved.pin.url,
              resolved.pin.commit,
              { ref: resolved.pin.ref, refLabel: resolved.pin.ref, refKind: resolved.pin.refKind },
              ({ checkout }) => execute(checkout)
            )
            : await execute(resolved.workspacePath);

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

      const resolved = await resolveMutableWorkspaceOr400(reply, request.body);
      if (resolved === null) {
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const job = d.jobs.start(
        'compiler.compile',
        { pathOrUrl, pluginId, ...(resolved.pin ? { pin: resolved.pin } : {}) },
        async (ctx): Promise<null> => {
          const execute = (workspacePath: string) => d.executor.execute(
            pluginId, 'compile', { pathOrUrl },
            { onOutput: (t) => ctx.log(t), workspacePath, signal: ctx.signal }
          );
          const result = resolved.pin
            ? await d.repos.withVersionMaterialized(
              resolved.profileId!,
              resolved.pin.url,
              resolved.pin.commit,
              { ref: resolved.pin.ref, refLabel: resolved.pin.ref, refKind: resolved.pin.refKind },
              ({ checkout }) => execute(checkout)
            )
            : await d.repos.withRepoLifecycleLock(
              pathOrUrl,
              resolved.profileId,
              () => execute(resolved.workspacePath)
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
    ): Promise<IApiResponse<ArtifactListServeResult>> => {
      try {
        const { pluginId, pathOrUrl } = request.body;

        if (await rejectNonCompilerPlugin(reply, pluginId)) {
          return reply as unknown as IApiResponse<ArtifactListServeResult>;
        }

        // Get hostPath from request body or fall back to environment/cwd
        const hostPath =
          pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();

        const resolved = await resolveMutableWorkspaceOr400(reply, request.body);
        if (resolved === null) {
          return reply as unknown as IApiResponse<ArtifactListServeResult>;
        }
        const execute = (workspacePath: string) => d.executor.execute(pluginId, 'listArtifacts', { pathOrUrl: hostPath }, { workspacePath });
        const result = resolved.pin
          ? await d.repos.withVersionMaterialized(resolved.profileId!, resolved.pin.url, resolved.pin.commit, { ref: resolved.pin.ref }, ({ checkout }) => execute(checkout))
          : await execute(resolved.workspacePath);

        if (!result.success) {
          return sendPluginError(
            reply,
            result,
            ErrorCodes.ARTIFACT_LISTING_ERROR,
            'Failed to list artifacts'
          );
        }

        const body: IApiResponse<ArtifactListServeResult> = {
          data: {
            status: 'ready',
            artifacts: (result.data as ArtifactListResult | undefined)?.artifacts ?? [],
          },
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
        const { pluginId, pathOrUrl, artifactPath, pin } = request.body;
        const hostPath =
          pathOrUrl || process.env.IGNITE_WORKSPACE_PATH || process.cwd();
        const profileId = (await ProfileManager.getInstance()).getCurrentProfile();
        const data = await getCompilerArtifactData(d, {
          profileId,
          contract: {
            id: 'artifact-data', repoPathOrUrl: hostPath, frameworkId: pluginId,
            artifactPath, contractName: '', sourcePath: '', ...(pin ? { pin } : {}),
          },
        });

        const body: IApiResponse<ArtifactData> = {
          data,
        };
        return reply.status(200).send(body);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: string }).code
            : undefined;
        if (code) {
          return sendBadRequest(
            reply,
            code as (typeof ErrorCodes)[keyof typeof ErrorCodes],
            error instanceof Error
              ? error.message
              : 'Failed to get artifact data'
          ) as unknown as IApiResponse<ArtifactData>;
        }
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
