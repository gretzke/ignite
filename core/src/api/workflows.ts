import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  canonicalGitUrl,
  canonicalJson,
  makeWorkflowDocumentSchema,
  sanitizeDisplayText,
  validateWorkflowClosure,
  type IApiResponse,
  type InstalledSourceSnapshot,
  type InstalledWorkflowRecord,
  type JobRecord,
  type WorkflowDocument,
  type WorkflowInstallDiff,
  type WorkflowPluginReadiness,
  type WorkflowSource,
  type WorkflowSourceDetail,
  type WorkflowStatusEntry,
  type WorkflowSummary,
  type JobStartedData,
} from '@ignite/api';
import { RepoService } from '../repos/RepoService.js';
import { VersionStore, type VersionRecord } from '../repos/VersionStore.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { WorkflowInstallService, WorkflowInstallServiceError, deriveWorkflowRequiredRoles, getWorkflowPluginReadiness, type RequiredRole } from '../workflows/WorkflowInstallService.js';
import { InstalledWorkflowStore } from '../workflows/InstalledWorkflowStore.js';
import { JobManager } from '../jobs/JobManager.js';
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

async function workflowCandidates(
  repos: WorkflowHandlerDeps['repos'],
  pathOrUrl: string
): Promise<{ entries: import('node:fs').Dirent[]; error?: string }> {
  const root = await repos.resolveExistingWorkspacePath(pathOrUrl);
  const realRoot = await fs.realpath(path.resolve(root));
  const directory = path.join(realRoot, 'ignite', 'workflows');
  try {
    const stats = await fs.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { entries: [], error: 'ignite/workflows must be a real directory inside the repository' };
    const realDirectory = await fs.realpath(directory);
    if (!realDirectory.startsWith(realRoot + path.sep)) return { entries: [], error: 'ignite/workflows resolves outside the repository' };
    const entries = await fs.readdir(realDirectory, { withFileTypes: true });
    return { entries: entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LIST_ENTRIES) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    throw error;
  }
}

export interface WorkflowHandlerDeps {
  repos: Pick<RepoService, 'resolveExistingWorkspacePath' | 'getFile' | 'withWorkflowWriteLock'>;
  devMode: () => boolean;
  versionStore: Pick<VersionStore, 'approveOrigins' | 'list' | 'checkoutPath'>;
  getProfileId: () => Promise<string>;
  installService?: Pick<WorkflowInstallService, 'start'>;
  installedWorkflows: Pick<InstalledWorkflowStore, 'read'>;
  jobs: Pick<JobManager, 'list'>;
  pluginStatus: (id: string, version: string, roles: ReadonlySet<RequiredRole>) => Promise<WorkflowPluginReadiness>;
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
    installedWorkflows: deps?.installedWorkflows ?? new InstalledWorkflowStore(),
    jobs: deps?.jobs ?? JobManager.getInstance(),
    pluginStatus: deps?.pluginStatus ?? getWorkflowPluginReadiness,
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

    getWorkflowsStatus: async (
      request: FastifyRequest<{ Querystring: { pathOrUrl: string } }>,
      reply: FastifyReply
    ): Promise<IApiResponse<{ workflows: WorkflowStatusEntry[] }>> => {
      try {
        // This route intentionally performs only reads. In particular, it must
        // never trigger lifecycle work, a sweep, or registry mutation.
        const candidates = await workflowCandidates(d.repos, request.query.pathOrUrl);
        if (candidates.error) return reply.status(200).send({ data: sanitizeStatus({ workflows: [{ name: 'workflows', valid: false, error: candidates.error }] }) });
        const profileId = await d.getProfileId();
        const [{ records }, versions, jobs] = await Promise.all([
          d.installedWorkflows.read(profileId),
          d.versionStore.list(),
          Promise.resolve(d.jobs.list({ active: true })),
        ]);
        const workflows: WorkflowStatusEntry[] = [];
        for (const entry of candidates.entries) {
          const name = entry.name.slice(0, -5);
          try {
            validateName(name);
            const file = await d.repos.getFile(request.query.pathOrUrl, relPath(name));
            if (!file.success) throw new WorkflowHttpError(422, file.error.code, file.error.message);
            const document = parseDocument(file.data.content, d.devMode());
            const docHash = hash(file.data.content);
            const record = records.find((candidate) => candidate.repoPathOrUrl === request.query.pathOrUrl && candidate.name === name);
            workflows.push(await workflowStatus({ document, name, docHash, record, versions, jobs, profileId, repoPathOrUrl: request.query.pathOrUrl, versionStore: d.versionStore, pluginStatus: d.pluginStatus }));
          } catch (error) {
            workflows.push({ name, valid: false, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return reply.status(200).send({ data: sanitizeStatus({ workflows }) });
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
          } else if (request.body.baseDocHash) {
            throw new WorkflowHttpError(409, 'WORKFLOW_DELETED', 'Workflow was deleted since it was loaded');
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

type StatusInputs = {
  document: WorkflowDocument;
  name: string;
  docHash: string;
  record: InstalledWorkflowRecord | undefined;
  versions: VersionRecord[];
  jobs: JobRecord[];
  profileId: string;
  repoPathOrUrl: string;
  versionStore: Pick<VersionStore, 'checkoutPath'>;
  pluginStatus: WorkflowHandlerDeps['pluginStatus'];
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function detailForSource(source: WorkflowSource | InstalledSourceSnapshot, ready = false): WorkflowSourceDetail {
  if ('kind' in source && source.kind === 'contract-type') return { id: source.id, ready };
  if ('origin' in source && source.origin === 'contract-type') return { id: source.id, contractName: source.contractName, ready };
  const repo = 'pin' in source ? source.pin : source.repo;
  return { id: source.id, contractName: source.contractName, canonicalUrl: canonicalGitUrl(repo.url), url: repo.url, ...(repo.ref ? { ref: repo.ref } : {}), commit: repo.commit, artifactPath: source.artifactPath, ready };
}

function isRepoSource(source: WorkflowSource | InstalledSourceSnapshot): source is Extract<WorkflowSource, { repo: unknown }> | Extract<InstalledSourceSnapshot, { kind: 'repo' }> {
  return !('kind' in source && source.kind === 'contract-type') && !('origin' in source && source.origin === 'contract-type');
}

function pinIdentity(source: Extract<WorkflowSource, { repo: unknown }> | Extract<InstalledSourceSnapshot, { kind: 'repo' }>): string {
  const pin = 'pin' in source ? source.pin : source.repo;
  return canonicalJson({ url: canonicalGitUrl(pin.url), commit: pin.commit, ref: pin.ref, refKind: pin.refKind });
}

function sourceSemantic(source: WorkflowSource | InstalledSourceSnapshot): string {
  if (!isRepoSource(source)) return canonicalJson('kind' in source
    ? { kind: source.kind, id: source.id, pluginId: source.pluginId, artifactKey: source.artifactKey, versionLabel: source.versionLabel, contentHash: source.contentHash }
    : { kind: 'contract-type', id: source.id, pluginId: source.pluginId, artifactKey: source.artifactKey, versionLabel: source.versionLabel, contentHash: source.contentHash });
  const pin = 'pin' in source ? source.pin : source.repo;
  return canonicalJson({ kind: 'repo', id: source.id, pin: { ...pin, url: canonicalGitUrl(pin.url) }, frameworkId: source.frameworkId, sourcePath: source.sourcePath, contractName: source.contractName, artifactPath: source.artifactPath, artifactHash: source.artifactHash });
}

function sourceRenameIdentity(source: Extract<WorkflowSource, { repo: unknown }> | Extract<InstalledSourceSnapshot, { kind: 'repo' }>): string {
  return canonicalJson({ pin: pinIdentity(source), contractName: source.contractName, artifactPath: source.artifactPath });
}

function diffFor(installed: NonNullable<InstalledWorkflowRecord['installed']>, document: WorkflowDocument): WorkflowInstallDiff {
  const oldById = new Map(installed.sources.map((source) => [source.id, source]));
  const currentById = new Map(document.sources.map((source) => [source.id, source]));
  const unmatchedOld = [...oldById.values()].filter((source) => !currentById.has(source.id));
  const unmatchedNew = [...currentById.values()].filter((source) => !oldById.has(source.id));
  const sourcesRenamed: WorkflowInstallDiff['sourcesRenamed'] = [];
  const consumedOld = new Set<string>();
  const consumedNew = new Set<string>();
  for (const oldSource of unmatchedOld) {
    if (!isRepoSource(oldSource)) continue;
    const newSource = unmatchedNew.find((candidate) => isRepoSource(candidate) && !consumedNew.has(candidate.id) && sourceRenameIdentity(oldSource) === sourceRenameIdentity(candidate));
    if (!newSource) continue;
    consumedOld.add(oldSource.id);
    consumedNew.add(newSource.id);
    sourcesRenamed.push({ from: oldSource.id, to: newSource.id, detail: detailForSource(newSource) });
  }
  const sourcesAdded = unmatchedNew.filter((source) => !consumedNew.has(source.id)).map((source) => detailForSource(source));
  const sourcesRemoved = unmatchedOld.filter((source) => !consumedOld.has(source.id)).map((source) => detailForSource(source));
  const versionsChanged: WorkflowInstallDiff['versionsChanged'] = [];
  const artifactsChanged: WorkflowInstallDiff['artifactsChanged'] = [];
  const sourcesModified: WorkflowInstallDiff['sourcesModified'] = [];
  let sourceChanged = sourcesAdded.length > 0 || sourcesRemoved.length > 0 || sourcesRenamed.length > 0;
  for (const source of document.sources) {
    const old = oldById.get(source.id);
    if (!old) continue;
    if (isRepoSource(source) && isRepoSource(old)) {
      const oldPin = (old as Extract<InstalledSourceSnapshot, { kind: 'repo' }>).pin;
      const newPin = source.repo;
      if (pinIdentity(old) !== pinIdentity(source)) versionsChanged.push({ detail: detailForSource(source), from: { ...(oldPin.ref ? { ref: oldPin.ref } : {}), commit: oldPin.commit }, to: { ...(newPin.ref ? { ref: newPin.ref } : {}), commit: newPin.commit } });
      if (old.artifactPath !== source.artifactPath || old.artifactHash !== source.artifactHash) artifactsChanged.push({ detail: detailForSource(source), from: old.artifactPath, to: source.artifactPath });
      const changes = [
        ...(old.frameworkId !== source.frameworkId ? ['frameworkId'] : []),
        ...(old.sourcePath !== source.sourcePath ? ['sourcePath'] : []),
        ...(old.contractName !== source.contractName ? ['contractName'] : []),
      ];
      if (changes.length) sourcesModified.push({ detail: detailForSource(source), changes });
    } else if (!isRepoSource(source) && !isRepoSource(old)) {
      const changes = [
        ...(old.pluginId !== source.pluginId ? ['pluginId'] : []),
        ...(old.artifactKey !== source.artifactKey ? ['artifactKey'] : []),
        ...(old.versionLabel !== source.versionLabel ? ['versionLabel'] : []),
        ...(old.contentHash !== source.contentHash ? ['contentHash'] : []),
      ];
      if (changes.length) sourcesModified.push({ detail: detailForSource(source), changes });
    } else {
      sourcesModified.push({ detail: detailForSource(source), changes: ['kind'] });
    }
    if (sourceSemantic(old) !== sourceSemantic(source)) sourceChanged = true;
  }
  const oldPlugins = new Map(installed.plugins.map((plugin) => [plugin.id, plugin]));
  const currentPlugins = new Map(document.requiredPlugins.map((plugin) => [plugin.id, plugin]));
  const pluginsChanged: WorkflowInstallDiff['pluginsChanged'] = [];
  for (const plugin of document.requiredPlugins) {
    const old = oldPlugins.get(plugin.id);
    if (!old) { pluginsChanged.push({ id: plugin.id, kind: 'added', to: plugin.version }); continue; }
    if (old.version !== plugin.version) pluginsChanged.push({ id: plugin.id, kind: 'version', from: old.version, to: plugin.version });
    const source = plugin.source ? canonicalJson(plugin.source) : undefined;
    if (old.source !== source) pluginsChanged.push({ id: plugin.id, kind: 'source', from: old.source, to: source });
  }
  for (const plugin of installed.plugins) if (!currentPlugins.has(plugin.id)) pluginsChanged.push({ id: plugin.id, kind: 'removed', from: plugin.version });
  const stepsChanged = installed.stepsHash !== sha256(canonicalJson(document.steps));
  const hooksChanged = installed.hooksHash !== sha256(canonicalJson(document.outputs));
  return { sourcesAdded, sourcesRemoved, sourcesRenamed, versionsChanged, artifactsChanged, sourcesModified, pluginsChanged, stepsChanged, hooksChanged, formattingOnly: !sourceChanged && pluginsChanged.length === 0 && !stepsChanged && !hooksChanged };
}

function runningAttempt(jobs: JobRecord[], profileId: string, repoPathOrUrl: string, name: string): WorkflowStatusEntry['attempt'] | undefined {
  const job = jobs.find((candidate) => candidate.type === 'workflow.install' && (candidate.state === 'queued' || candidate.state === 'running') && candidate.params.profileId === profileId && candidate.params.repoPathOrUrl === repoPathOrUrl && candidate.params.name === name);
  return job ? { status: 'running', jobId: job.id } : undefined;
}

async function workflowStatus(input: StatusInputs): Promise<WorkflowStatusEntry> {
  const { document, record, versions } = input;
  const installed = record?.installed;
  const attempt = runningAttempt(input.jobs, input.profileId, input.repoPathOrUrl, input.name)
    ?? (record?.lastAttempt && (!installed || new Date(record.lastAttempt.at).getTime() > new Date(installed.at).getTime())
      ? { status: record.lastAttempt.status, error: record.lastAttempt.error, ...(record.lastAttempt.failedSources ? { failedSources: record.lastAttempt.failedSources } : {}), atDocHash: record.lastAttempt.docHash }
      : { status: 'idle' as const });
  const roles = deriveWorkflowRequiredRoles(document);
  const plugins = await Promise.all(document.requiredPlugins.map((plugin) => input.pluginStatus(plugin.id, plugin.version, roles.get(plugin.id) ?? new Set())));
  const base: WorkflowStatusEntry = { name: input.name, valid: true, docHash: input.docHash, ...(installed ? { installedDocHash: installed.docHash } : {}), attempt };
  if (!installed) return { ...base, installState: 'not-installed', sources: document.sources.map((source) => detailForSource(source)), plugins };
  if (installed.docHash !== input.docHash) return { ...base, installState: 'out-of-sync', diff: diffFor(installed, document), sources: document.sources.map((source) => detailForSource(source)), plugins };

  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const sources: WorkflowSourceDetail[] = [];
  for (const source of document.sources) {
    let detail = detailForSource(source, true);
    const pluginId = source.origin === 'contract-type' ? source.pluginId : source.frameworkId;
    const compiler = pluginById.get(pluginId);
    if (!compiler || compiler.status !== 'installed') detail = { ...detail, ready: false, reason: `Plugin ${pluginId} is ${compiler?.status ?? 'missing'}`, code: compiler?.status ?? 'missing' };
    else if (source.origin !== 'contract-type') {
      const version = versions.find((candidate) => canonicalGitUrl(candidate.url) === canonicalGitUrl(source.repo.url) && candidate.commit === source.repo.commit);
      if (!version) detail = { ...detail, ready: false, reason: 'Version record is missing', code: 'VERSION_MISSING' };
      else if (!version.frameworks?.find((framework) => framework.id === source.frameworkId)?.compiledAt) detail = { ...detail, ready: false, reason: 'Framework is not compiled', code: 'FRAMEWORK_NOT_COMPILED' };
      else if (!version.compiledWith?.some((compiled) => compiled.pluginId === source.frameworkId && compiled.version === compiler.installedVersion)) detail = { ...detail, ready: false, reason: 'Compiler version changed', code: 'COMPILED_WITH_DRIFT' };
      else {
        try {
          const stats = await fs.stat(input.versionStore.checkoutPath(source.repo.url, source.repo.commit));
          if (!stats.isDirectory()) detail = { ...detail, ready: false, reason: 'Version checkout is not a directory', code: 'CHECKOUT_INVALID' };
        } catch {
          detail = { ...detail, ready: false, reason: 'Version checkout is missing', code: 'CHECKOUT_MISSING' };
        }
      }
    }
    sources.push(detail);
  }
  const ready = sources.every((source) => source.ready) && plugins.every((plugin) => plugin.status === 'installed');
  return { ...base, installState: ready ? 'ready' : 'not-installed', sources, plugins };
}

function sanitizeStatus<T>(value: T): T {
  if (typeof value === 'string') return sanitizeDisplayText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeStatus(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeStatus(item)])) as T;
  return value;
}

export const workflowHandlers = createWorkflowHandlers();
