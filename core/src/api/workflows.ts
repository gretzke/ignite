import path from 'node:path';
import fs from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  makeWorkflowDocumentSchema,
  validateWorkflowClosure,
  type IApiResponse,
  type WorkflowDocument,
  type WorkflowSummary,
  type JobStartedData,
} from '@ignite/api';
import { RepoService } from '../repos/RepoService.js';
import { VersionStore } from '../repos/VersionStore.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { WorkflowInstallService, WorkflowInstallServiceError } from '../workflows/WorkflowInstallService.js';
import {
  WorkflowHttpError,
  hashWorkflowRaw as hash,
  parseWorkflowDocument as parseDocument,
  readWorkflowDocument,
  validateWorkflowName as validateName,
  workflowRelPath as relPath,
} from '../workflows/WorkflowDocumentReader.js';

export { WorkflowHttpError, readWorkflowDocument };

const MAX_WORKFLOW_BYTES = 512 * 1024;
const MAX_LIST_ENTRIES = 256;

export interface WorkflowHandlerDeps {
  repos: Pick<RepoService, 'resolveExistingWorkspacePath' | 'getFile' | 'withWorkflowWriteLock'>;
  devMode: () => boolean;
  versionStore: Pick<VersionStore, 'approveOrigins'>;
  getProfileId: () => Promise<string>;
  installService?: Pick<WorkflowInstallService, 'start'>;
}
function fail(reply: FastifyReply, error: unknown) {
  const known = error instanceof WorkflowHttpError ? error : error instanceof WorkflowInstallServiceError ? new WorkflowHttpError(error.statusCode, error.code, error.message, error.details) : new WorkflowHttpError(404, 'REPO_NOT_FOUND', error instanceof Error ? error.message : String(error));
  return reply.status(known.statusCode).send({ statusCode: known.statusCode, error: known.statusCode === 404 ? 'Not Found' : known.statusCode === 409 ? 'Conflict' : known.statusCode === 422 ? 'Unprocessable Entity' : 'Bad Request', code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) });
}

export function createWorkflowHandlers(deps?: Partial<WorkflowHandlerDeps>) {
  const d: WorkflowHandlerDeps = {
    repos: deps?.repos ?? RepoService.getInstance(),
    devMode: deps?.devMode ?? (() => process.env.NODE_ENV === 'development'),
    versionStore: deps?.versionStore ?? new VersionStore(),
    getProfileId: deps?.getProfileId ?? (async () => (await ProfileManager.getInstance()).getCurrentProfile()),
  };
  const installService = deps?.installService;
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
        const started = await (
          installService ?? WorkflowInstallService.getInstance()
        ).start(profileId, request.body);
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

export const workflowHandlers = createWorkflowHandlers();
