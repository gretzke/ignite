import fs from 'node:fs/promises';
import path from 'node:path';
import { getAddress } from 'viem';
import {
  DeploymentArtifactSchema,
  makeWorkflowDocumentSchema,
  type DeploymentArtifact,
  type PointerSuggestion,
  type PointerSuggestionData,
  type PointerSuggestionRequest,
  type WorkflowDocument,
} from '@ignite/api';
import { FileSystem } from '../filesystem/FileSystem.js';
import { RepoService } from '../repos/RepoService.js';
import { getLogger } from '../utils/logger.js';
import { DeploymentHookService, type HookAddressSuggestion } from './DeploymentHookService.js';

const MAX_FILES = 512;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 4;
const SCAN_MS = 5_000;

interface CandidateFile { file: string; size: number; mtimeMs: number }
interface ScanBudget { startedAt: number; files: number; bytes: number; truncated: boolean }
interface ArtifactCandidate { chainId: number; address: `0x${string}`; artifactHash: string; versionLabel?: string; source: { kind: 'artifact'; runId: string; at: string } }

export interface PointerSuggestionServiceDeps {
  baseDir: string;
  resolveWorkspace: (pathOrUrl: string) => Promise<string>;
  readWorkflow: (ref: { repoPathOrUrl: string; name: string }) => Promise<WorkflowDocument>;
  hooks: Pick<DeploymentHookService, 'suggest'>;
  now: () => number;
  readdir: typeof fs.readdir;
  lstat: typeof fs.lstat;
  readFile: typeof fs.readFile;
}

export class PointerSuggestionService {
  private readonly deps: PointerSuggestionServiceDeps;

  constructor(deps?: Partial<PointerSuggestionServiceDeps>) {
    this.deps = {
      baseDir: deps?.baseDir ?? FileSystem.getInstance().getIgniteHome(),
      resolveWorkspace: deps?.resolveWorkspace ?? ((value) => RepoService.getInstance().resolveExistingWorkspacePath(value)),
      readWorkflow: deps?.readWorkflow ?? readWorkflow,
      hooks: deps?.hooks ?? DeploymentHookService.getInstance(),
      now: deps?.now ?? Date.now,
      readdir: deps?.readdir ?? fs.readdir,
      lstat: deps?.lstat ?? fs.lstat,
      readFile: deps?.readFile ?? fs.readFile,
    };
  }

  async suggest(request: PointerSuggestionRequest, profileId: string): Promise<PointerSuggestionData> {
    const chainIds = new Set(request.chainIds);
    const grouped = Object.fromEntries(request.chainIds.map((chainId) => [String(chainId), [] as PointerSuggestion[]]));
    const budget: ScanBudget = { startedAt: this.deps.now(), files: 0, bytes: 0, truncated: false };
    let workflow: WorkflowDocument | undefined;
    let workspace: string | undefined;
    if (request.workflow) {
      workflow = await this.deps.readWorkflow(request.workflow);
      if (request.sourceId && !workflow.sources.some((source) => source.id === request.sourceId))
        throw Object.assign(new Error(`Workflow source not found: ${request.sourceId}`), { code: 'WORKFLOW_SOURCE_NOT_FOUND' });
      workspace = await this.deps.resolveWorkspace(request.workflow.repoPathOrUrl);
    }

    const candidates: ArtifactCandidate[] = [];
    const files: CandidateFile[] = [];
    await this.collect(path.join(this.deps.baseDir, 'profiles', profileId, 'deployments', 'artifacts'), 0, budget, files);
    if (workspace)
      await this.collect(path.join(workspace, 'ignite', 'deployments'), 0, budget, files);
    await this.scanFiles(files, request.contractName, chainIds, budget, candidates);

    for (const candidate of candidates) {
      const suggestion: PointerSuggestion = {
        address: getAddress(candidate.address),
        match: request.expectedArtifactHash && candidate.artifactHash === request.expectedArtifactHash ? 'artifact-hash' : 'name',
        ...(candidate.versionLabel ? { versionLabel: candidate.versionLabel } : {}),
        sources: [candidate.source],
      };
      merge(grouped[String(candidate.chainId)], suggestion);
    }
    if (workflow && workspace) {
      const hookSuggestions = await this.deps.hooks.suggest(
        workflow.outputs.hooks,
        workspace,
        { chainIds: request.chainIds, contractName: request.contractName },
      );
      for (const candidate of hookSuggestions) {
        if (!chainIds.has(candidate.chainId)) continue;
        merge(grouped[String(candidate.chainId)], fromHook(candidate));
      }
    }
    for (const suggestions of Object.values(grouped)) {
      suggestions.sort((a, b) => quality(b) - quality(a) || newest(b).localeCompare(newest(a)) || a.address.localeCompare(b.address));
      suggestions.splice(8);
    }
    return { suggestionsByChain: grouped, truncated: budget.truncated };
  }

  private async scanFiles(candidates: CandidateFile[], contractName: string, chainIds: Set<number>, budget: ScanBudget, output: ArtifactCandidate[]): Promise<void> {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
    if (candidates.length > MAX_FILES - budget.files) budget.truncated = true;
    for (const candidate of candidates.slice(0, Math.max(0, MAX_FILES - budget.files))) {
      if (this.expired(budget)) { budget.truncated = true; break; }
      if (budget.bytes + candidate.size > MAX_BYTES) { budget.truncated = true; break; }
      budget.files += 1; budget.bytes += candidate.size;
      try {
        const raw = await this.deps.readFile(candidate.file, 'utf8');
        const parsed = DeploymentArtifactSchema.safeParse(JSON.parse(raw as string));
        if (!parsed.success) { getLogger().debug(`Skipping malformed deployment artifact ${candidate.file}`); continue; }
        output.push(...artifactCandidates(parsed.data, contractName, chainIds));
      } catch { getLogger().debug(`Skipping unreadable deployment artifact ${candidate.file}`); }
    }
  }

  private async collect(root: string, depth: number, budget: ScanBudget, output: CandidateFile[]): Promise<void> {
    if (this.expired(budget)) { budget.truncated = true; return; }
    let entries: import('node:fs').Dirent[];
    try { entries = await this.deps.readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (this.expired(budget)) { budget.truncated = true; return; }
      const candidate = path.join(root, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await this.collect(candidate, depth + 1, budget, output);
        else budget.truncated = true;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const stats = await this.deps.lstat(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      output.push({ file: candidate, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }

  private expired(budget: ScanBudget): boolean { return this.deps.now() - budget.startedAt >= SCAN_MS; }
}

async function readWorkflow(ref: { repoPathOrUrl: string; name: string }): Promise<WorkflowDocument> {
  const result = await RepoService.getInstance().getFile(ref.repoPathOrUrl, `ignite/workflows/${ref.name}.json`);
  if (!result.success) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return makeWorkflowDocumentSchema({ allowFileUrls: process.env.NODE_ENV === 'development' }).parse(JSON.parse(result.data.content));
}

function artifactCandidates(artifact: DeploymentArtifact, contractName: string, chainIds: Set<number>): ArtifactCandidate[] {
  const contracts = new Map(artifact.contracts.filter((entry) => entry.contractName === contractName).map((entry) => [entry.id, entry]));
  const output: ArtifactCandidate[] = [];
  for (const lane of Object.values(artifact.lanes)) {
    if (!chainIds.has(lane.chainId)) continue;
    for (const step of lane.steps) {
      const contract = contracts.get(step.contractId);
      if (!contract || step.kind !== 'deploy' || step.status !== 'confirmed' || !step.address) continue;
      output.push({ chainId: lane.chainId, address: step.address, artifactHash: contract.artifactHash, ...(contract.versionLabel ? { versionLabel: contract.versionLabel } : {}), source: { kind: 'artifact', runId: artifact.runId, at: artifact.updatedAt } });
    }
  }
  return output;
}

function fromHook(candidate: HookAddressSuggestion): PointerSuggestion {
  return { address: candidate.address, match: 'name', ...(candidate.versionLabel ? { versionLabel: candidate.versionLabel } : {}), sources: [{ kind: 'plugin', pluginId: candidate.pluginId, ...(candidate.label ? { label: candidate.label } : {}) }] };
}
function quality(value: PointerSuggestion): number { return value.match === 'artifact-hash' ? 1 : 0; }
function newest(value: PointerSuggestion): string { return value.sources.flatMap((source) => source.kind === 'artifact' ? [source.at] : []).sort().at(-1) ?? ''; }
function merge(target: PointerSuggestion[], incoming: PointerSuggestion): void {
  const current = target.find((entry) => entry.address.toLowerCase() === incoming.address.toLowerCase());
  if (!current) { target.push(incoming); return; }
  const sources = [...current.sources];
  for (const source of incoming.sources)
    if (!sources.some((entry) => JSON.stringify(entry) === JSON.stringify(source))) sources.push(source);
  if (quality(incoming) > quality(current)) {
    current.match = incoming.match;
    current.versionLabel = incoming.versionLabel;
  } else if (!current.versionLabel && incoming.versionLabel) current.versionLabel = incoming.versionLabel;
  current.sources = sources;
}
