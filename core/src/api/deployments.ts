import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreateRunData,
  CreateRunRequest,
  GetDeploymentArtifactData,
  GetRunData,
  IApiResponse,
  ListRunsData,
  ListRunsQuery,
  PrepareStepData,
  PrepareStepRequest,
  ResolveLaneRequest,
  RunRecord,
  ValidateDeploymentData,
  ValidateDeploymentRequest,
} from '@ignite/api';
import {
  effectiveSalt,
  initcodeHashOf,
  predictCreate2Address,
} from '../deployments/create2.js';
import {
  buildInitcode,
  predictPlanAddresses,
} from '../deployments/schedule.js';
import { validateDependencies } from '../deployments/resolver.js';
import { ArtifactFreezeService } from '../deployments/ArtifactFreezeService.js';
import { DeploymentTypeService } from '../deployments/DeploymentTypeService.js';
import { renderArtifact } from '../deployments/artifact.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { DeployEngine } from '../deployments/DeployEngine.js';
import { ErrorCodes, IgniteError } from '../types/errors.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { sendCaughtError } from './utils/errors.js';

type ProfileSource = { getCurrentProfile(): string };
type RunIdParams = { runId: string };
type ResolveLaneParams = { runId: string; chainId: string };
export interface DeploymentHandlerDeps {
  engine: Pick<DeployEngine, 'launch' | 'resolveLane' | 'resume' | 'abort'>;
  getProfileManager: () => Promise<ProfileSource>;
  validate: DeployEngine['launch'] extends never
    ? never
    : (
        plan: ValidateDeploymentRequest['plan'],
        rpc: ValidateDeploymentRequest['rpcSelection'],
        opts?: {
          profileId?: string;
          explorerSelection?: Record<string, string[]>;
        }
      ) => Promise<{ report: ValidateDeploymentData; frozen: unknown }>;
  getRun: (profileId: string, runId: string) => Promise<RunRecord | undefined>;
  listVerifications: (
    profileId: string,
    runId: string
  ) => Promise<import('@ignite/api').VerificationTask[]>;
  listRuns: (
    profileId: string
  ) => Promise<{ runs: ListRunsData['runs']; unreadable: string[] }>;
  freezeInputs: (
    profileId: string,
    contracts: PrepareStepRequest['contracts']
  ) => Promise<import('@ignite/api').FrozenInputs>;
  deploymentTypes: Pick<DeploymentTypeService, 'prepare'>;
}

export function createDeploymentHandlers(
  deps?: Partial<DeploymentHandlerDeps>
) {
  // Resolve the singleton per request. Tests and process lifecycle recovery
  // replace it after shutdown; capturing it while the API module loads would
  // keep routing requests into the stopped engine (and its stale signer/WS
  // dependencies).
  const engine = () => deps?.engine ?? DeployEngine.getInstance();
  const d: DeploymentHandlerDeps = {
    engine: engine(),
    getProfileManager:
      deps?.getProfileManager ?? (() => ProfileManager.getInstance()),
    validate:
      deps?.validate ??
      ((plan, rpc, opts) =>
        DeployEngine.getInstance().validatePlan(plan, rpc, opts)),
    getRun:
      deps?.getRun ??
      ((profileId, runId) => DeployEngine.getInstance().get(profileId, runId)),
    listRuns:
      deps?.listRuns ??
      ((profileId) => DeployEngine.getInstance().list(profileId)),
    listVerifications:
      deps?.listVerifications ??
      ((profileId, runId) =>
        VerificationQueue.getInstance().store.list(profileId, { runId })),
    freezeInputs:
      deps?.freezeInputs ??
      ((profile, contracts) =>
        new ArtifactFreezeService().freezeInputs(profile, contracts)),
    deploymentTypes:
      deps?.deploymentTypes ?? DeploymentTypeService.getInstance(),
  };
  const profileId = async () =>
    (await d.getProfileManager()).getCurrentProfile();
  const notFound = (reply: FastifyReply, message: string) =>
    reply
      .status(404)
      .send({
        statusCode: 404,
        error: 'Not Found',
        code: ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND,
        message,
      });
  const deploymentError = (reply: FastifyReply, error: unknown): any => {
    if (error instanceof IgniteError) {
      const status =
        error.code === ErrorCodes.PLUGIN_PREPARE_MISMATCH
          ? 500
          : error.code === ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND
            ? 404
            : error.code === ErrorCodes.STALE_RESOLVE
              ? 409
              : 400;
      return reply
        .status(status)
        .send({
          statusCode: status,
          error:
            status === 404
              ? 'Not Found'
              : status === 409
                ? 'Conflict'
                : 'Bad Request',
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
    }
    return sendCaughtError(
      reply,
      error,
      ErrorCodes.DEPLOYMENT_VALIDATION_FAILED,
      'Deployment request failed'
    );
  };
  return {
    validateDeployment: async (
      request: FastifyRequest<{ Body: ValidateDeploymentRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ValidateDeploymentData>> => {
      try {
        const result = await d.validate(
          request.body.plan,
          request.body.rpcSelection,
          {
            profileId: await profileId(),
            explorerSelection: request.body.explorerSelection,
          }
        );
        return reply
          .status(200)
          .send({
            data: {
              chains: result.report.chains,
              frozenCandidates:
                result.frozen as ValidateDeploymentData['frozenCandidates'],
            },
          });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    prepareDeploymentStep: async (
      request: FastifyRequest<{ Body: PrepareStepRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<PrepareStepData>> => {
      try {
        const body = request.body;
        const candidate = body.steps.find((item) => item.id === body.stepId);
        if (!candidate || candidate.kind !== 'deploy')
          throw new IgniteError(
            'stepId must name a deploy step',
            'POINTER_NOT_CONCRETE'
          );
        const step = candidate;
        const plan = {
          schemaVersion: 1 as const,
          contracts: body.contracts,
          steps: body.steps,
          chains: body.chainIds,
          signers: {},
        };
        try {
          validateDependencies(plan);
        } catch (error) {
          throw mapPreparePointerError(error, plan);
        }
        // Freezing the submitted context is deliberately server-authoritative;
        // resolving only a client-provided address map would bypass §3 rules.
        const frozen = await d.freezeInputs(await profileId(), body.contracts);
        const input = frozen[step.contractId];
        if (!input)
          throw new IgniteError(
            `Frozen input for ${step.contractId} is missing`,
            'CONTRACT_INPUT_NOT_FOUND'
          );
        const predictionPlan =
          step.strategy?.kind === 'plugin'
            ? {
                ...plan,
                steps: plan.steps.map((item) =>
                  item.id === step.id
                    ? { ...item, strategy: { kind: 'create' as const } }
                    : item
                ),
              }
            : plan;
        const chains: PrepareStepData['chains'] = {};
        for (const chainId of body.chainIds) {
          let predictions: ReturnType<typeof predictPlanAddresses>;
          try {
            predictions = predictPlanAddresses(predictionPlan, frozen, chainId);
          } catch (error) {
            throw mapPreparePointerError(error, plan);
          }
          let initcode: `0x${string}`;
          try {
            initcode = buildInitcode(
              step,
              input,
              chainId,
              (id) =>
                predictions[id]?.predictedAddress ??
                (() => {
                  throw new Error(`Missing predicted pointer ${id}`);
                })()
            );
          } catch (error) {
            throw mapPreparePointerError(error, plan);
          }
          const initcodeHash = initcodeHashOf(initcode);
          if (step.strategy?.kind === 'plugin') {
            const prepared = await d.deploymentTypes.prepare(
              step.strategy.pluginId,
              { chainId, initcode, params: step.strategy.params }
            );
            const predictedAddress = predictCreate2Address(
              prepared.salt,
              initcodeHash
            );
            if (
              prepared.predictedAddress.toLowerCase() !==
              predictedAddress.toLowerCase()
            )
              throw new IgniteError(
                'Deployment-type plugin returned an address that does not match its salt and initcode',
                ErrorCodes.PLUGIN_PREPARE_MISMATCH
              );
            chains[String(chainId)] = {
              salt: prepared.salt,
              predictedAddress,
              initcodeHash,
              notes: prepared.notes,
            };
            continue;
          }
          if (step.strategy?.kind !== 'create2')
            throw new IgniteError(
              'Only create2 and plugin steps can be prepared',
              'PREPARE_STRATEGY_INVALID'
            );
          const salt = effectiveSalt(step.strategy, chainId);
          if (!salt)
            throw new IgniteError(
              `No create2 salt is available for chain ${chainId}`,
              'CREATE2_SALT_REQUIRED'
            );
          chains[String(chainId)] = {
            salt,
            initcodeHash,
            predictedAddress: predictCreate2Address(salt, initcodeHash),
            notes: [],
          };
        }
        return reply.status(200).send({ data: { chains } });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    createDeploymentRun: async (
      request: FastifyRequest<{ Body: CreateRunRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<CreateRunData>> => {
      try {
        const run = await engine().launch({
          profileId: await profileId(),
          ...request.body,
        });
        return reply.status(200).send({ data: { run } });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    listDeploymentRuns: async (
      request: FastifyRequest<{ Querystring: ListRunsQuery }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListRunsData>> => {
      try {
        const data = await d.listRuns(await profileId());
        const active = request.query.active;
        return reply
          .status(200)
          .send({
            data: {
              unreadable: data.unreadable,
              runs:
                active === undefined
                  ? data.runs
                  : data.runs.filter((run) =>
                      active === 'true'
                        ? ['running', 'paused'].includes(run.status)
                        : !['running', 'paused'].includes(run.status)
                    ),
            },
          });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    getDeploymentRun: async (
      request: FastifyRequest<{ Params: RunIdParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetRunData>> => {
      try {
        const run = await d.getRun(await profileId(), request.params.runId);
        return run
          ? reply.status(200).send({ data: { run } })
          : notFound(reply, 'Deployment run not found');
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    resolveDeploymentLane: async (
      request: FastifyRequest<{
        Params: ResolveLaneParams;
        Body: ResolveLaneRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetRunData>> => {
      try {
        const run = await engine().resolveLane(
          await profileId(),
          request.params.runId,
          Number(request.params.chainId),
          request.body
        );
        return reply.status(200).send({ data: { run } });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    resumeDeploymentRun: async (
      request: FastifyRequest<{ Params: RunIdParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetRunData>> => {
      try {
        const run = await engine().resume(
          await profileId(),
          request.params.runId
        );
        return reply.status(200).send({ data: { run } });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    abortDeploymentRun: async (
      request: FastifyRequest<{ Params: RunIdParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetRunData>> => {
      try {
        const run = await engine().abort(
          await profileId(),
          request.params.runId
        );
        return reply.status(200).send({ data: { run } });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
    getDeploymentArtifact: async (
      request: FastifyRequest<{ Params: RunIdParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetDeploymentArtifactData>> => {
      try {
        const profile = await profileId();
        const run = await d.getRun(profile, request.params.runId);
        if (
          !run ||
          !Object.values(run.lanes).some(
            (lane) => lane.status === 'completed' || lane.status === 'aborted'
          )
        )
          return notFound(reply, 'Deployment artifact is not available yet');
        return reply
          .status(200)
          .send({
            data: {
              artifact: renderArtifact(
                run,
                await d.listVerifications(profile, run.id)
              ),
            },
          });
      } catch (error) {
        return deploymentError(reply, error);
      }
    },
  };
}

export const deploymentHandlers = createDeploymentHandlers();

function mapPreparePointerError(
  error: unknown,
  plan: { steps: PrepareStepRequest['steps'] }
): unknown {
  if ((error as { code?: string })?.code === 'CREATE2_POINTER_NOT_CONCRETE') {
    return new IgniteError(
      error instanceof Error ? error.message : 'Pointer is not concrete',
      'POINTER_NOT_CONCRETE',
      (error as { details?: Record<string, unknown> }).details
    );
  }
  if ((error as { code?: string })?.code !== 'POINTER_UNRESOLVED') return error;
  const details = (error as { details?: { stepId?: string } }).details;
  const target = plan.steps.find((step) => step.id === details?.stepId);
  if (
    target?.kind === 'deploy' &&
    (!target.strategy || target.strategy.kind === 'create')
  ) {
    return new IgniteError(
      `Pointer ${details?.stepId ?? ''} is not concrete because it targets a plain create step`,
      'POINTER_NOT_CONCRETE',
      details
    );
  }
  return error;
}
