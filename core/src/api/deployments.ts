import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  CreateRunData,
  CreateRunRequest,
  GetDeploymentArtifactData,
  GetRunData,
  IApiResponse,
  ListRunsData,
  ListRunsQuery,
  ResolveLaneRequest,
  ValidateDeploymentData,
  ValidateDeploymentRequest,
} from '@ignite/api';
import { renderArtifact } from '../deployments/artifact.js';
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
  validate: DeployEngine['launch'] extends never ? never : (plan: ValidateDeploymentRequest['plan'], rpc: ValidateDeploymentRequest['rpcSelection'], opts?: { profileId?: string }) => Promise<{ report: ValidateDeploymentData; frozen: unknown }>;
  getRun: (profileId: string, runId: string) => Promise<any>;
  listRuns: (profileId: string) => Promise<{ runs: ListRunsData['runs']; unreadable: string[] }>;
}

export function createDeploymentHandlers(deps?: Partial<DeploymentHandlerDeps>) {
  const engine = deps?.engine ?? DeployEngine.getInstance();
  const d: DeploymentHandlerDeps = {
    engine,
    getProfileManager: deps?.getProfileManager ?? (() => ProfileManager.getInstance()),
    validate: deps?.validate ?? ((plan, rpc, opts) => DeployEngine.getInstance().validatePlan(plan, rpc, opts)),
    getRun: deps?.getRun ?? ((profileId, runId) => DeployEngine.getInstance().get(profileId, runId)),
    listRuns: deps?.listRuns ?? ((profileId) => DeployEngine.getInstance().list(profileId)),
  };
  const profileId = async () => (await d.getProfileManager()).getCurrentProfile();
  const notFound = (reply: FastifyReply, message: string) => reply.status(404).send({ statusCode: 404, error: 'Not Found', code: ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND, message });
  const deploymentError = (reply: FastifyReply, error: unknown): any => {
    if (error instanceof IgniteError) {
      const status = error.code === ErrorCodes.DEPLOYMENT_RUN_NOT_FOUND ? 404 : error.code === ErrorCodes.STALE_RESOLVE ? 409 : 400;
      return reply.status(status).send({ statusCode: status, error: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Bad Request', code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    return sendCaughtError(reply, error, ErrorCodes.DEPLOYMENT_VALIDATION_FAILED, 'Deployment request failed');
  };
  return {
    validateDeployment: async (request: FastifyRequest<{ Body: ValidateDeploymentRequest }>, reply: FastifyReply): Promise<IApiResponse<ValidateDeploymentData>> => {
      try { const result = await d.validate(request.body.plan, request.body.rpcSelection, { profileId: await profileId() }); return reply.status(200).send({ data: { chains: result.report.chains, frozenCandidates: result.frozen as ValidateDeploymentData['frozenCandidates'] } }); } catch (error) { return deploymentError(reply, error); }
    },
    createDeploymentRun: async (request: FastifyRequest<{ Body: CreateRunRequest }>, reply: FastifyReply): Promise<IApiResponse<CreateRunData>> => {
      try { const run = await engine.launch({ profileId: await profileId(), ...request.body }); return reply.status(200).send({ data: { run } }); } catch (error) { return deploymentError(reply, error); }
    },
    listDeploymentRuns: async (request: FastifyRequest<{ Querystring: ListRunsQuery }>, reply: FastifyReply): Promise<IApiResponse<ListRunsData>> => {
      try { const data = await d.listRuns(await profileId()); const active = request.query.active; return reply.status(200).send({ data: { unreadable: data.unreadable, runs: active === undefined ? data.runs : data.runs.filter((run) => active === 'true' ? ['running', 'paused'].includes(run.status) : !['running', 'paused'].includes(run.status)) } }); } catch (error) { return deploymentError(reply, error); }
    },
    getDeploymentRun: async (request: FastifyRequest<{ Params: RunIdParams }>, reply: FastifyReply): Promise<IApiResponse<GetRunData>> => {
      try { const run = await d.getRun(await profileId(), request.params.runId); return run ? reply.status(200).send({ data: { run } }) : notFound(reply, 'Deployment run not found'); } catch (error) { return deploymentError(reply, error); }
    },
    resolveDeploymentLane: async (request: FastifyRequest<{ Params: ResolveLaneParams; Body: ResolveLaneRequest }>, reply: FastifyReply): Promise<IApiResponse<GetRunData>> => {
      try { const run = await engine.resolveLane(await profileId(), request.params.runId, Number(request.params.chainId), request.body); return reply.status(200).send({ data: { run } }); } catch (error) { return deploymentError(reply, error); }
    },
    resumeDeploymentRun: async (request: FastifyRequest<{ Params: RunIdParams }>, reply: FastifyReply): Promise<IApiResponse<GetRunData>> => {
      try { const run = await engine.resume(await profileId(), request.params.runId); return reply.status(200).send({ data: { run } }); } catch (error) { return deploymentError(reply, error); }
    },
    abortDeploymentRun: async (request: FastifyRequest<{ Params: RunIdParams }>, reply: FastifyReply): Promise<IApiResponse<GetRunData>> => {
      try { const run = await engine.abort(await profileId(), request.params.runId); return reply.status(200).send({ data: { run } }); } catch (error) { return deploymentError(reply, error); }
    },
    getDeploymentArtifact: async (request: FastifyRequest<{ Params: RunIdParams }>, reply: FastifyReply): Promise<IApiResponse<GetDeploymentArtifactData>> => {
      try { const run = await d.getRun(await profileId(), request.params.runId); if (!run || !Object.values(run.lanes).some((lane: any) => lane.status === 'completed' || lane.status === 'aborted')) return notFound(reply, 'Deployment artifact is not available yet'); return reply.status(200).send({ data: { artifact: renderArtifact(run) } }); } catch (error) { return deploymentError(reply, error); }
    },
  };
}

export const deploymentHandlers = createDeploymentHandlers();
