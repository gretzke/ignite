import type {
  InspectGitRemoteData,
  WorkflowCheckUpdatesData,
  WorkflowCheckUpdatesRequest,
  WorkflowDocument,
  WorkflowPluginUpdate,
  WorkflowRequiredPlugin,
  WorkflowSourceUpdate,
} from '@ignite/api';
import { makeWorkflowDocumentSchema } from '@ignite/api';
import { RepoService } from '../repos/RepoService.js';
import { inspectGitRemote, compareVersionStrings } from '../plugins/install/gitRemote.js';
import { PluginRegistryLoader } from '../assets/PluginRegistryLoader.js';
import { PluginManager } from '../filesystem/PluginManager.js';
import { pluginVersionInfo } from '../api/plugins/versions.js';
import type { PluginConfig } from '../assets/PluginRegistryLoader.js';
import type { PluginInstallSource } from '../plugins/install/types.js';
import type { PluginVersionInfoData } from '@ignite/api';
import { PinnedStore, pinnedOrigin } from '../repos/PinnedStore.js';
import { ProfileManager } from '../filesystem/ProfileManager.js';

export interface WorkflowUpdateServiceDeps {
  readWorkflow: (request: WorkflowCheckUpdatesRequest) => Promise<WorkflowDocument>;
  inspectRemote: (url: string) => Promise<InspectGitRemoteData>;
  pluginRows: (plugins: WorkflowRequiredPlugin[]) => Promise<WorkflowPluginUpdate[]>;
  getProfileId: () => Promise<string>;
  isOriginApproved: (profileId: string, url: string) => Promise<boolean>;
}

export class WorkflowUpdateService {
  private readonly deps: WorkflowUpdateServiceDeps;
  constructor(deps?: Partial<WorkflowUpdateServiceDeps>) {
    this.deps = {
      readWorkflow: deps?.readWorkflow ?? readWorkflow,
      inspectRemote: deps?.inspectRemote ?? inspectGitRemote,
      pluginRows: deps?.pluginRows ?? requiredPluginRows,
      getProfileId: deps?.getProfileId ?? (async () => (await ProfileManager.getInstance()).getCurrentProfile()),
      isOriginApproved: deps?.isOriginApproved ?? ((profileId, url) => new PinnedStore().isOriginApproved(profileId, url)),
    };
  }

  async check(request: WorkflowCheckUpdatesRequest): Promise<WorkflowCheckUpdatesData> {
    const document = await this.deps.readWorkflow(request);
    const profileId = await this.deps.getProfileId();
    const sources: WorkflowSourceUpdate[] = [];
    for (const source of document.sources) {
      const pin = source.repo;
      if (!(await this.deps.isOriginApproved(profileId, pin.url))) {
        sources.push({ sourceId: source.id, status: 'approval-required', currentCommit: pin.commit, origin: pinnedOrigin(pin.url) });
        continue;
      }
      if (!pin.ref || !pin.refKind) {
        sources.push({ sourceId: source.id, status: 'up-to-date', currentCommit: pin.commit });
        continue;
      }
      try {
        const remote = await this.deps.inspectRemote(pin.url);
        if (pin.refKind === 'branch') {
          const latestCommit = remote.branchHeads?.[pin.ref];
          if (!latestCommit) sources.push({ sourceId: source.id, status: 'error', currentCommit: pin.commit, error: `Branch ${pin.ref} no longer exists upstream` });
          else sources.push({ sourceId: source.id, status: latestCommit === pin.commit ? 'up-to-date' : 'branch-moved', currentCommit: pin.commit, ...(latestCommit !== pin.commit ? { latestCommit } : {}) });
          continue;
        }
        const release = remote.releases.find((candidate) => candidate.tag === pin.ref);
        const latestTagCommit = remote.tagHeads ? remote.tagHeads[pin.ref] : release?.sha;
        if (!latestTagCommit) { sources.push({ sourceId: source.id, status: 'tag-deleted', currentCommit: pin.commit }); continue; }
        if (latestTagCommit !== pin.commit) { sources.push({ sourceId: source.id, status: 'tag-retargeted', currentCommit: pin.commit, latestCommit: latestTagCommit }); continue; }
        if (!release) { sources.push({ sourceId: source.id, status: 'up-to-date', currentCommit: pin.commit }); continue; }
        const upgrades = remote.releases
          .filter((candidate) => compareVersionStrings(candidate.version, release.version) === 1)
          .map((candidate) => ({ ref: candidate.tag, commit: candidate.sha, version: candidate.version }));
        sources.push({ sourceId: source.id, status: upgrades.length ? 'upgrade-available' : 'up-to-date', currentCommit: pin.commit, ...(upgrades.length ? { upgrades } : {}) });
      } catch (error) {
        sources.push({ sourceId: source.id, status: 'error', currentCommit: pin.commit, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { sources, plugins: await this.deps.pluginRows(document.requiredPlugins) };
  }
}

async function readWorkflow(request: WorkflowCheckUpdatesRequest): Promise<WorkflowDocument> {
  const result = await RepoService.getInstance().getFile(request.repoPathOrUrl, `ignite/workflows/${request.name}.json`);
  if (!result.success) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return makeWorkflowDocumentSchema({ allowFileUrls: process.env.NODE_ENV === 'development' }).parse(JSON.parse(result.data.content));
}

export async function requiredPluginRows(required: WorkflowRequiredPlugin[], deps?: {
  getConfig: (id: string) => Promise<PluginConfig | undefined>;
  getSource: (id: string) => Promise<PluginInstallSource | undefined>;
  versionInfo: (id: string, version: string, source: PluginInstallSource | undefined) => Promise<PluginVersionInfoData>;
}): Promise<WorkflowPluginUpdate[]> {
  const registry = PluginRegistryLoader.getInstance();
  const manager = PluginManager.getInstance();
  const d = deps ?? {
    getConfig: (id: string) => registry.getPluginConfig(id).catch(() => undefined),
    getSource: (id: string) => manager.getInstallSource(id),
    versionInfo: (id: string, version: string, source: PluginInstallSource | undefined) => pluginVersionInfo(id, version, source),
  };
  return Promise.all(required.map(async (plugin) => {
    const config = await d.getConfig(plugin.id);
    if (!config) return { id: plugin.id, requiredVersion: plugin.version, status: 'missing' as const, updateAvailable: false };
    const source = config.origin === 'installed' ? await d.getSource(plugin.id) : undefined;
    const update = await d.versionInfo(plugin.id, config.metadata.version, source);
    return {
      id: plugin.id, requiredVersion: plugin.version,
      status: config.metadata.version === plugin.version ? 'installed' as const : 'version-mismatch' as const,
      installedVersion: config.metadata.version, updateAvailable: update.updateAvailable, update,
    };
  }));
}
