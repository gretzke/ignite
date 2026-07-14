import crypto from 'node:crypto';
import type {
  DeploymentPlan,
  RunRecord,
  WorkflowDocument,
  WorkflowPromoteData,
  WorkflowPromoteRequest,
  WorkflowRequiredPlugin,
  WorkflowSource,
  WorkflowSummary,
} from '@ignite/api';
import { makeWorkflowDocumentSchema, WorkflowNamePattern } from '@ignite/api';
import { normalizeRepoUrl } from '@ignite/plugin-types';
import { RepoService, type PromotionSourceInspection } from '../repos/RepoService.js';
import { RunStore } from '../deployments/RunStore.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { PluginManager } from '../filesystem/PluginManager.js';
import { VerificationQueue } from '../verifications/VerificationQueue.js';
import { renderArtifact } from '../deployments/artifact.js';
import { ArtifactFreezeService } from '../deployments/ArtifactFreezeService.js';
import type { FrozenInputs } from '@ignite/api';

type PreviewRequest = Extract<WorkflowPromoteRequest, { mode: 'preview' }>;
type ApplyRequest = Extract<WorkflowPromoteRequest, { mode: 'apply' }>;
type PreviewData = Extract<WorkflowPromoteData, { mode: 'preview' }>;
type ApplyData = Extract<WorkflowPromoteData, { mode: 'apply' }>;

interface WorkflowFiles {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
}
interface PreviewSnapshot {
  target: string;
  inputKey: string;
  sources: PreviewData['sources'];
  inspections: Map<string, PromotionSourceInspection>;
}
export interface WorkflowPromotionServiceDeps {
  inspectSource: (pathOrUrl: string) => Promise<PromotionSourceInspection>;
  readTargetFile: (repo: string, file: string) => Promise<string | null>;
  withWorkflowWriteLock: <T>(repo: string, fn: (files: WorkflowFiles) => Promise<T>) => Promise<T>;
  getRun: (profileId: string, runId: string) => Promise<RunRecord | undefined>;
  getRequiredPlugin: (id: string) => Promise<WorkflowRequiredPlugin>;
  renderRunArtifact: (profileId: string, runId: string) => Promise<unknown>;
  freezeInputs: (profileId: string, plan: DeploymentPlan) => Promise<FrozenInputs>;
  validateTargetRepo: (repo: string) => Promise<boolean>;
}

export class WorkflowPromotionError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 422, readonly code: string, message: string) { super(message); }
}

export class WorkflowPromotionService {
  private readonly deps: WorkflowPromotionServiceDeps;
  private readonly previews = new Map<string, PreviewSnapshot>();

  constructor(deps?: Partial<WorkflowPromotionServiceDeps>) {
    const repos = RepoService.getInstance();
    this.deps = {
      inspectSource: deps?.inspectSource ?? ((value) => repos.inspectPromotionSource(value)),
      readTargetFile: deps?.readTargetFile ?? (async (repo, file) => {
        const result = await repos.getFile(repo, file);
        if (result.success) return result.data.content;
        if (result.error.code === 'FILE_NOT_FOUND') return null;
        throw Object.assign(new Error(result.error.message), { code: result.error.code });
      }),
      withWorkflowWriteLock: deps?.withWorkflowWriteLock ?? ((repo, fn) => repos.withWorkflowWriteLock(repo, fn)),
      getRun: deps?.getRun ?? ((profileId, runId) => new RunStore().get(profileId, runId)),
      getRequiredPlugin: deps?.getRequiredPlugin ?? requiredPlugin,
      renderRunArtifact: deps?.renderRunArtifact ?? (async (profileId, runId) => {
        const run = await new RunStore().get(profileId, runId);
        if (!run) throw new WorkflowPromotionError(404, 'DEPLOYMENT_RUN_NOT_FOUND', `Deployment run not found: ${runId}`);
        const tasks = await VerificationQueue.getInstance().store.list(profileId, { runId });
        return renderArtifact(run, tasks);
      }),
      freezeInputs: deps?.freezeInputs ?? ((profileId, plan) => new ArtifactFreezeService().freezeInputs(profileId, plan.contracts)),
      validateTargetRepo: deps?.validateTargetRepo ?? ((repo) => repos.isExistingGitRepository(repo)),
    };
  }

  async promote(request: PreviewRequest, profileId: string): Promise<PreviewData>;
  async promote(request: ApplyRequest, profileId: string): Promise<ApplyData>;
  async promote(request: WorkflowPromoteRequest, profileId: string): Promise<WorkflowPromoteData> {
    this.validateTarget(request.target);
    return request.mode === 'preview' ? this.preview(request, profileId) : this.apply(request, profileId);
  }

  private async preview(request: PreviewRequest, profileId: string): Promise<PreviewData> {
    if (!(await this.deps.validateTargetRepo(request.target.repoPathOrUrl)))
      throw new WorkflowPromotionError(422, 'PROMOTION_TARGET_INVALID', 'Promotion target must be an existing git repository');
    const { plan } = await this.resolveInput(request, profileId);
    const sources: PreviewData['sources'] = [];
    const inspections = new Map<string, PromotionSourceInspection>();
    for (const source of plan.contracts) {
      if (source.pin) {
        sources.push({ sourceId: source.id, origin: source.pin.url, commit: source.pin.commit, tagChoices: source.pin.refKind === 'tag' && source.pin.ref ? [source.pin.ref] : [], dirty: false });
        continue;
      }
      try {
        const inspected = await this.deps.inspectSource(source.repoPathOrUrl);
        const normalized = { ...inspected, origin: promotionOrigin(inspected.origin), tags: [...inspected.tags].sort() };
        inspections.set(source.id, normalized);
        sources.push({ sourceId: source.id, origin: normalized.origin, commit: normalized.commit, tagChoices: normalized.tags, dirty: normalized.dirty });
      } catch (error) {
        sources.push({ sourceId: source.id, origin: '', commit: '', tagChoices: [], dirty: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const file = workflowPath(request.target.name);
    const nameCollision = (await this.deps.readTargetFile(request.target.repoPathOrUrl, file)) !== null;
    const previewId = crypto.randomUUID();
    this.previews.set(previewId, { target: targetKey(request.target), inputKey: inputKey(request), sources, inspections });
    while (this.previews.size > 128) this.previews.delete(this.previews.keys().next().value!);
    return { mode: 'preview', previewId, sources, nameCollision };
  }

  private async apply(request: ApplyRequest, profileId: string): Promise<ApplyData> {
    const snapshot = this.previews.get(request.previewId);
    if (!snapshot || snapshot.target !== targetKey(request.target) || snapshot.inputKey !== inputKey(request))
      throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', 'Promotion preview is missing or no longer matches this request');
    const { plan, run } = await this.resolveInput(request, profileId);
    const previewErrors = snapshot.sources.filter((source) => source.error);
    if (previewErrors.length) throw new WorkflowPromotionError(422, 'PROMOTION_SOURCE_INVALID', previewErrors.map((source) => `${source.sourceId}: ${source.error}`).join('; '));

    const pins = new Map<string, WorkflowSource['repo']>();
    for (const source of plan.contracts) {
      if (source.pin) { pins.set(source.id, globalThis.structuredClone(source.pin)); continue; }
      const before = snapshot.inspections.get(source.id);
      if (!before) throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', `Source ${source.id} was not resolved by the preview`);
      let current: PromotionSourceInspection;
      try { current = await this.deps.inspectSource(source.repoPathOrUrl); }
      catch { throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', `Source ${source.id} can no longer be inspected`); }
      const currentOrigin = promotionOrigin(current.origin);
      if (currentOrigin !== before.origin || current.commit !== before.commit)
        throw new WorkflowPromotionError(409, 'PROMOTION_PREVIEW_STALE', `Source ${source.id} HEAD or origin changed since preview`);
      const tags = [...current.tags].sort();
      let ref: string | undefined;
      let refKind: 'tag' | 'branch' | undefined;
      if (tags.length === 1) { ref = tags[0]; refKind = 'tag'; }
      else if (tags.length > 1) {
        ref = request.tagChoiceBySourceId?.[source.id];
        if (!ref || !tags.includes(ref)) throw new WorkflowPromotionError(422, 'PROMOTION_TAG_CHOICE_REQUIRED', `Choose one tag for source ${source.id}`);
        refKind = 'tag';
      } else if (current.branch) { ref = current.branch; refKind = 'branch'; }
      pins.set(source.id, { url: currentOrigin, commit: current.commit, ...(ref ? { ref, refKind } : {}) });
    }

    let document: WorkflowDocument;
    try { document = await this.buildDocument(plan, run, pins, request.hooks, profileId); }
    catch (error) {
      if (error instanceof WorkflowPromotionError) throw error;
      throw new WorkflowPromotionError(422, 'PROMOTION_DOCUMENT_INVALID', error instanceof Error ? error.message : String(error));
    }
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const docHash = crypto.createHash('sha256').update(raw).digest('hex');
    const uniqueAdoptions = [...new Set(request.adoptRunIds ?? [])];
    // Resolve every adopted run against the current profile and render every
    // artifact before entering the write transaction. A bad adoption can
    // therefore never leave the workflow file applied on its own.
    const adoptedArtifacts = new Map<string, string>();
    for (const runId of uniqueAdoptions) {
      if (!(await this.deps.getRun(profileId, runId)))
        throw new WorkflowPromotionError(404, 'DEPLOYMENT_RUN_NOT_FOUND', `Deployment run not found: ${runId}`);
      const artifact = await this.deps.renderRunArtifact(profileId, runId);
      adoptedArtifacts.set(runId, `${JSON.stringify(artifact, null, 2)}\n`);
    }
    await this.deps.withWorkflowWriteLock(request.target.repoPathOrUrl, async (files) => {
      const existing = await files.readFile(workflowPath(request.target.name));
      if (existing !== null && !request.overwrite)
        throw new WorkflowPromotionError(409, 'WORKFLOW_NAME_CONFLICT', `Workflow ${request.target.name} already exists`);
      await files.writeFile(workflowPath(request.target.name), raw);
      for (const runId of uniqueAdoptions) {
        await files.writeFile(`ignite/deployments/${request.target.name}/${runId}.json`, adoptedArtifacts.get(runId)!);
      }
    });
    this.previews.delete(request.previewId);
    return { mode: 'apply', workflow: summary(request.target.name, document), docHash };
  }

  private async buildDocument(plan: DeploymentPlan, run: RunRecord | undefined, pins: Map<string, WorkflowSource['repo']>, hooks: string[], profileId: string): Promise<WorkflowDocument> {
    const frozen = run?.inputs ?? await this.deps.freezeInputs(profileId, plan).catch(() => undefined);
    const sources: WorkflowSource[] = plan.contracts.map((source) => ({
      id: source.id, repo: pins.get(source.id)!, frameworkId: source.frameworkId, sourcePath: source.sourcePath,
      contractName: source.contractName, artifactPath: source.artifactPath,
      ...(frozen?.[source.id]?.artifactHash ? { artifactHash: frozen[source.id].artifactHash } : {}),
    }));
    const pluginIds = new Set<string>([...sources.map((source) => source.frameworkId), ...hooks]);
    for (const step of plan.steps)
      if (step.kind === 'deploy' && step.strategy?.kind === 'plugin') pluginIds.add(step.strategy.pluginId);
    const requiredPlugins = await Promise.all([...pluginIds].sort().map((id) => this.deps.getRequiredPlugin(id)));
    const steps = plan.steps.map((step) => {
      const copy = globalThis.structuredClone(step) as typeof step & { signerOverride?: unknown };
      delete copy.signerOverride;
      return copy;
    });
    const candidate = { schemaVersion: 1 as const, sources, steps, defaultChains: [...plan.chains], requiredPlugins, outputs: { hooks: [...hooks] } };
    return makeWorkflowDocumentSchema({ allowFileUrls: process.env.NODE_ENV === 'development' }).parse(candidate);
  }

  private async resolveInput(request: Pick<WorkflowPromoteRequest, 'plan' | 'runId'>, profileId: string): Promise<{ plan: DeploymentPlan; run?: RunRecord }> {
    if (request.plan) return { plan: globalThis.structuredClone(request.plan) };
    if (!request.runId) throw new WorkflowPromotionError(400, 'PROMOTION_INPUT_REQUIRED', 'Exactly one of plan or runId is required');
    const run = await this.deps.getRun(profileId, request.runId);
    if (!run) throw new WorkflowPromotionError(404, 'DEPLOYMENT_RUN_NOT_FOUND', `Deployment run not found: ${request.runId}`);
    return { plan: globalThis.structuredClone(run.plan), run };
  }

  private validateTarget(target: { repoPathOrUrl: string; name: string }): void {
    if (!WorkflowNamePattern.test(target.name)) throw new WorkflowPromotionError(400, 'WORKFLOW_NAME_INVALID', 'Workflow name is invalid');
  }
}

async function requiredPlugin(id: string): Promise<WorkflowRequiredPlugin> {
  const config = await PluginRegistryLoader.getInstance().getPluginConfig(id).catch(() => undefined);
  if (!config) throw new WorkflowPromotionError(422, 'PROMOTION_PLUGIN_MISSING', `Required plugin is not installed: ${id}`);
  const source = config.origin === 'installed' ? await PluginManager.getInstance().getInstallSource(id) : undefined;
  return {
    id, version: config.metadata.version,
    ...(source?.kind === 'git' ? { source: { kind: 'git' as const, url: source.url, ...(source.ref ? { ref: source.ref } : {}), ...(source.track ? { track: source.track } : {}), ...(source.commit ? { commit: source.commit } : {}) } } : {}),
  };
}
function workflowPath(name: string): string { return `ignite/workflows/${name}.json`; }
function targetKey(target: { repoPathOrUrl: string; name: string }): string { return `${target.repoPathOrUrl}\0${target.name}`; }
function inputKey(request: Pick<WorkflowPromoteRequest, 'plan' | 'runId'>): string {
  return request.runId ? `run:${request.runId}` : `plan:${crypto.createHash('sha256').update(JSON.stringify(request.plan)).digest('hex')}`;
}
function summary(name: string, document: WorkflowDocument): WorkflowSummary {
  return { name, valid: true, sourceCount: document.sources.length, stepCount: document.steps.length, ...(document.defaultChains ? { defaultChains: document.defaultChains } : {}), hooks: document.outputs.hooks };
}
function promotionOrigin(origin: string): string {
  const normalized = normalizeRepoUrl(origin);
  try {
    const url = new URL(normalized);
    if (url.username || url.password) throw new Error('credentials are not allowed');
    if (url.protocol === 'https:' || (process.env.NODE_ENV === 'development' && url.protocol === 'file:')) return normalized;
  } catch (error) {
    if (error instanceof WorkflowPromotionError) throw error;
  }
  throw new WorkflowPromotionError(422, 'PROMOTION_ORIGIN_UNSUPPORTED', 'origin must be a credential-free HTTPS URL (or file:// in development)');
}
