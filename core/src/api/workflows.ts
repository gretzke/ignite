import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  WorkflowNamePattern,
  makeWorkflowDocumentSchema,
  validateWorkflowClosure,
  type IApiResponse,
  type WorkflowDocument,
  type WorkflowSummary,
  type WorkflowSource,
  type WorkflowPluginReadiness,
  type JobStartedData,
} from '@ignite/api';
import { RepoService } from '../repos/RepoService.js';
import { JobManager } from '../jobs/JobManager.js';
import { RepoLifecycle } from '../repos/RepoLifecycle.js';
import { VersionStore } from '../repos/VersionStore.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { TrustManager } from '../plugins/trust/TrustManager.js';
import { getCompilerArtifactData } from './plugins/compiler/index.js';
import { PluginExecutor } from '../plugins/containers/PluginExecutor.js';
import { ContractTypeService } from '../deployments/ContractTypeService.js';
import { PluginType } from '@ignite/plugin-types/types';
import { InstalledWorkflowStore } from '../workflows/InstalledWorkflowStore.js';
import { WorkflowInstallService, WorkflowInstallServiceError } from '../workflows/WorkflowInstallService.js';

const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 256;

export interface WorkflowHandlerDeps {
  repos: Pick<RepoService, 'resolveExistingWorkspacePath' | 'getFile' | 'withWorkflowWriteLock'>;
  devMode: () => boolean;
  jobs: Pick<JobManager, 'start' | 'get' | 'list'>;
  lifecycle: Pick<RepoLifecycle, 'runPinnedLifecycle'>;
  versionStore: Pick<VersionStore, 'approveOrigins' | 'isOriginApproved' | 'addMembership'>;
  registry: Pick<ProfileRepoRegistry, 'list'>;
  installedWorkflows: Pick<InstalledWorkflowStore, 'get' | 'writeInstalled' | 'writeAttempt'>;
  getProfileId: () => Promise<string>;
  pluginStatus: (id: string, requiredVersion: string, requiredRoles: ReadonlySet<PluginType>) => Promise<WorkflowPluginReadiness>;
  artifactReadable: (source: WorkflowSource, profileId: string) => Promise<boolean>;
  installService?: Pick<WorkflowInstallService, 'start'>;
}

export class WorkflowHttpError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 422, readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); }
}

function hash(raw: string): string { return crypto.createHash('sha256').update(raw).digest('hex'); }
function relPath(name: string): string { return `ignite/workflows/${name}.json`; }
function parseDocument(raw: string, allowFileUrls: boolean): WorkflowDocument {
  if (Buffer.byteLength(raw) > MAX_WORKFLOW_BYTES) throw new WorkflowHttpError(422, 'WORKFLOW_TOO_LARGE', 'Workflow exceeds 512 KiB');
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new WorkflowHttpError(422, 'WORKFLOW_JSON_INVALID', error instanceof Error ? error.message : String(error)); }
  const parsed = makeWorkflowDocumentSchema({ allowFileUrls }).safeParse(value);
  if (!parsed.success) throw new WorkflowHttpError(422, 'WORKFLOW_INVALID', parsed.error.message);
  const document = parsed.data;
  const missing = validateWorkflowClosure(document);
  if (missing.length > 0) throw new WorkflowHttpError(422, 'WORKFLOW_CLOSURE_INVALID', `Missing required plugin ids: ${missing.join(', ')}`);
  return document;
}
function fail(reply: FastifyReply, error: unknown) {
  const known = error instanceof WorkflowHttpError ? error : error instanceof WorkflowInstallServiceError ? new WorkflowHttpError(error.statusCode, error.code, error.message, error.details) : new WorkflowHttpError(404, 'REPO_NOT_FOUND', error instanceof Error ? error.message : String(error));
  return reply.status(known.statusCode).send({ statusCode: known.statusCode, error: known.statusCode === 404 ? 'Not Found' : known.statusCode === 409 ? 'Conflict' : known.statusCode === 422 ? 'Unprocessable Entity' : 'Bad Request', code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) });
}
function validateName(name: string): void {
  if (!WorkflowNamePattern.test(name)) throw new WorkflowHttpError(400, 'WORKFLOW_NAME_INVALID', 'Workflow name is invalid');
}

export async function readWorkflowDocument(
  repos: Pick<RepoService, 'getFile'>,
  pathOrUrl: string,
  name: string,
  allowFileUrls: boolean,
): Promise<{ document: WorkflowDocument; raw: string; docHash: string }> {
  validateName(name);
  const result = await repos.getFile(pathOrUrl, relPath(name));
  if (!result.success) throw new WorkflowHttpError(result.error.code === 'FILE_NOT_FOUND' ? 404 : 400, result.error.code, result.error.message);
  const raw = result.data.content;
  return { document: parseDocument(raw, allowFileUrls), raw, docHash: hash(raw) };
}

export function createWorkflowHandlers(deps?: Partial<WorkflowHandlerDeps>) {
  const registry = PluginRegistryLoader.getInstance();
  const repos = deps?.repos ?? RepoService.getInstance();
  const d: WorkflowHandlerDeps = {
    repos,
    devMode: deps?.devMode ?? (() => process.env.NODE_ENV === 'development'),
    jobs: deps?.jobs ?? JobManager.getInstance(),
    lifecycle: deps?.lifecycle ?? RepoLifecycle.getInstance(),
    versionStore: deps?.versionStore ?? new VersionStore(),
    registry: deps?.registry ?? new ProfileRepoRegistry(),
    installedWorkflows: deps?.installedWorkflows ?? new InstalledWorkflowStore(),
    getProfileId: deps?.getProfileId ?? (async () => (await ProfileManager.getInstance()).getCurrentProfile()),
    pluginStatus: deps?.pluginStatus ?? (async (id, requiredVersion, requiredRoles) => {
      let config;
      try { config = await registry.getPluginConfig(id); }
      catch { return { id, status: 'missing' }; }
      const installedVersion = config.metadata.version;
      if ((await TrustManager.getInstance().getGrant(id)).trust === 'untrusted') return { id, status: 'untrusted', installedVersion };
      if (installedVersion !== requiredVersion) return { id, status: 'version-mismatch', installedVersion };
      return [...requiredRoles].every((role) => config.metadata.types.includes(role)) ? { id, status: 'installed', installedVersion } : { id, status: 'wrong-type', installedVersion };
    }),
    artifactReadable: deps?.artifactReadable ?? (async (source, profileId) => {
      if (source.origin === 'contract-type') {
        const frozen = await ContractTypeService.getInstance().frozenDescriptor(source.pluginId);
        if (frozen.contentHash !== source.contentHash)
          throw new WorkflowHttpError(422, 'CONTRACT_TYPE_DRIFT', `Contract type ${source.pluginId} no longer matches the workflow content hash`);
        return true;
      }
      const contract = workflowSourceToContract(source);
      await getCompilerArtifactData({ executor: PluginExecutor.getInstance(), registryLoader: registry, repos: repos as RepoService }, { contract, profileId });
      return true;
    }),
  };
  const installService = deps?.installService ?? new WorkflowInstallService({
    readDocument: (repoPathOrUrl, name) => readWorkflowDocument(d.repos, repoPathOrUrl, name, d.devMode()),
    jobs: d.jobs,
    lifecycle: d.lifecycle,
    versionStore: d.versionStore,
    registry: d.registry,
    store: d.installedWorkflows,
    pluginStatus: d.pluginStatus,
    artifactReadable: d.artifactReadable,
  });
  return {
    listWorkflows: async (
      request: FastifyRequest<{ Querystring: { pathOrUrl: string } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<{ workflows: WorkflowSummary[]; truncated: boolean }>> => {
      try {
        const root = await d.repos.resolveExistingWorkspacePath(request.query.pathOrUrl);
        const realRoot = await fs.realpath(path.resolve(root));
        const directory = path.join(realRoot, 'ignite', 'workflows');
        let entries: import('node:fs').Dirent[];
        try {
          const directoryStats = await fs.lstat(directory);
          if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory())
            return reply.status(200).send({ data: { workflows: [{ name: 'workflows', valid: false, error: 'ignite/workflows must be a real directory inside the repository' }], truncated: false } });
          const realDirectory = await fs.realpath(directory);
          if (!realDirectory.startsWith(realRoot + path.sep))
            return reply.status(200).send({ data: { workflows: [{ name: 'workflows', valid: false, error: 'ignite/workflows resolves outside the repository' }], truncated: false } });
          entries = await fs.readdir(realDirectory, { withFileTypes: true });
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.status(200).send({ data: { workflows: [], truncated: false } }); throw error; }
        const candidates = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
        const truncated = candidates.length > MAX_LIST_ENTRIES;
        const workflows: WorkflowSummary[] = [];
        for (const entry of candidates.slice(0, MAX_LIST_ENTRIES)) {
          const name = entry.name.slice(0, -5);
          try {
            validateName(name);
            const result = await d.repos.getFile(request.query.pathOrUrl, relPath(name));
            if (!result.success) throw new WorkflowHttpError(422, result.error.code, result.error.message);
            const document = parseDocument(result.data.content, d.devMode());
            workflows.push({ name, valid: true, ...(document.description ? { description: document.description } : {}), sourceCount: document.sources.length, stepCount: document.steps.length, hooks: document.outputs.hooks });
          } catch (error) {
            workflows.push({ name, valid: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return reply.status(200).send({ data: { workflows, truncated } });
      } catch (error) { return fail(reply, error); }
    },

    getWorkflow: async (
      request: FastifyRequest<{ Params: { name: string }; Querystring: { pathOrUrl: string } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<{ document: WorkflowDocument; raw: string; docHash: string }>> => {
      try {
        return reply.status(200).send({ data: await readWorkflowDocument(d.repos, request.query.pathOrUrl, request.params.name, d.devMode()) });
      } catch (error) { return fail(reply, error); }
    },

    putWorkflow: async (
      request: FastifyRequest<{ Params: { name: string }; Querystring: { pathOrUrl: string }; Body: { document: unknown; baseDocHash?: string } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<{ docHash: string }>> => {
      try {
        validateName(request.params.name);
        const document = makeWorkflowDocumentSchema({ allowFileUrls: d.devMode() }).parse(request.body.document);
        const missing = validateWorkflowClosure(document);
        if (missing.length > 0) throw new WorkflowHttpError(400, 'WORKFLOW_CLOSURE_INVALID', `Missing required plugin ids: ${missing.join(', ')}`);
        const raw = `${JSON.stringify(document, null, 2)}\n`;
        if (Buffer.byteLength(raw) > MAX_WORKFLOW_BYTES) throw new WorkflowHttpError(400, 'WORKFLOW_TOO_LARGE', 'Workflow exceeds 512 KiB');
        const docHash = await d.repos.withWorkflowWriteLock(request.query.pathOrUrl, async ({ readFile, writeFile }) => {
          const current = await readFile(relPath(request.params.name));
          if (current !== null) {
            if (!request.body.baseDocHash) throw new WorkflowHttpError(409, 'WORKFLOW_BASE_HASH_REQUIRED', 'baseDocHash is required when updating an existing workflow');
            if (hash(current) !== request.body.baseDocHash) throw new WorkflowHttpError(409, 'WORKFLOW_DOC_CONFLICT', 'Workflow changed since it was loaded');
          }
          await writeFile(relPath(request.params.name), raw);
          return hash(raw);
        });
        return reply.status(200).send({ data: { docHash } });
      } catch (error) {
        if (error && typeof error === 'object' && 'issues' in error) return fail(reply, new WorkflowHttpError(400, 'WORKFLOW_INVALID', error instanceof Error ? error.message : String(error)));
        return fail(reply, error);
      }
    },

    installWorkflow: async (
      request: FastifyRequest<{ Body: { repoPathOrUrl: string; name: string; expectedDocHash: string } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      try {
        const profileId = await d.getProfileId();
        const started = await installService.start(profileId, request.body);
        return reply.status(200).send({ data: { jobId: started.jobId } });
      } catch (error) { return fail(reply, error); }
    },

    approveWorkflowOrigins: async (
      request: FastifyRequest<{ Body: { origins: string[] } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<{ origins: string[] }>> => {
      try {
        const profileId = await d.getProfileId();
        await d.versionStore.approveOrigins(profileId, request.body.origins);
        return reply.status(200).send({ data: { origins: request.body.origins } });
      } catch (error) { return fail(reply, new WorkflowHttpError(400, 'PINNED_ORIGIN_INVALID', error instanceof Error ? error.message : String(error))); }
    },
  } as const;
}

function workflowSourceToContract(source: WorkflowSource) {
  if (source.origin === 'contract-type') return {
    id: source.id, origin: 'contract-type', contractName: source.contractName,
    pluginId: source.pluginId, artifactKey: source.artifactKey,
    versionLabel: source.versionLabel, contentHash: source.contentHash,
  } as import('@ignite/api').ContractSource;
  return {
    id: source.id, repoPathOrUrl: source.repo.url, frameworkId: source.frameworkId,
    artifactPath: source.artifactPath, contractName: source.contractName, sourcePath: source.sourcePath,
    pin: { url: source.repo.url, commit: source.repo.commit, ...(source.repo.ref ? { ref: source.repo.ref, refKind: source.repo.refKind } : {}) },
  } as import('@ignite/api').ContractSource;
}

export const workflowHandlers = createWorkflowHandlers();
