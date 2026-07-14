// Version/update info for installed third-party plugins, plus the curated
// plugin store. Update availability derives from what each install tracks:
// branch → remote head moved; release → newer semver tag; commit → never.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiResponse,
  PluginVersionsData,
  PluginVersionInfoData,
  PluginStoreData,
} from '@ignite/api';
import { PluginManager } from '../../filesystem/PluginManager.js';
import {
  fetchRemoteRefs,
  releasesFromTags,
  compareVersionStrings,
  type RemoteRefs,
} from '../../plugins/install/gitRemote.js';
import type { PluginInstallSource } from '../../plugins/install/types.js';
import { CURATED_PLUGINS } from '../../plugins/store/curatedPlugins.js';
import { sendCaughtError } from '../utils/errors.js';

// Injectable for tests; production uses the real registry + ls-remote.
export interface VersionsHandlerDeps {
  listPlugins: () => Promise<Record<string, { id: string; version: string }>>;
  getInstallSource: (
    pluginId: string
  ) => Promise<PluginInstallSource | undefined>;
  fetchRemoteRefs: (url: string) => Promise<RemoteRefs>;
}

export async function pluginVersionInfo(
  pluginId: string,
  installedVersion: string,
  source: PluginInstallSource | undefined,
  loadRemoteRefs: (url: string) => Promise<RemoteRefs> = fetchRemoteRefs,
): Promise<PluginVersionInfoData> {
  if (!source || source.kind === 'local') return { pluginId, source: 'local', updateAvailable: false };
  const base: PluginVersionInfoData = {
    pluginId, source: 'git', repoUrl: source.url,
    ...(source.description ? { description: source.description } : {}),
    ...(source.track ? { track: source.track.mode } : {}),
    ...(source.commit ? { currentCommit: source.commit } : {}), updateAvailable: false,
  };
  const track = source.track;
  if (!track || track.mode === 'commit') return base;
  try {
    const refs = await loadRemoteRefs(source.url);
    if (track.mode === 'branch') {
      const latestCommit = refs.branches[track.branch];
      return { ...base, trackRef: track.branch, ...(latestCommit ? { latestCommit } : {}), updateAvailable: !!latestCommit && !!source.commit && latestCommit !== source.commit };
    }
    const releases = releasesFromTags(refs.tags).filter((release) => !release.prerelease);
    const latest = releases[0]; const currentVersion = track.version.replace(/^v/, '');
    const cmp = latest ? compareVersionStrings(latest.version, currentVersion) : null;
    return { ...base, trackRef: track.version, currentVersion, ...(latest ? { latestVersion: latest.version, latestCommit: latest.sha } : {}), updateAvailable: cmp !== null && cmp > 0 };
  } catch (error) {
    return { ...base, ...(track.mode === 'branch' ? { trackRef: track.branch } : { trackRef: track.version, currentVersion: track.version }), checkError: error instanceof Error ? error.message : String(error) };
  }
}

export function createVersionsHandlers(deps?: Partial<VersionsHandlerDeps>) {
  const d: VersionsHandlerDeps = {
    listPlugins:
      deps?.listPlugins ?? (() => PluginManager.getInstance().listPlugins()),
    getInstallSource:
      deps?.getInstallSource ??
      ((pluginId) => PluginManager.getInstance().getInstallSource(pluginId)),
    fetchRemoteRefs: deps?.fetchRemoteRefs ?? fetchRemoteRefs,
  };

  async function versionInfo(
    pluginId: string,
    installedVersion: string,
    source: PluginInstallSource | undefined
  ): Promise<PluginVersionInfoData> {
    return pluginVersionInfo(pluginId, installedVersion, source, d.fetchRemoteRefs);
  }

  return {
    pluginVersions: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<PluginVersionsData>> => {
      try {
        const installed = await d.listPlugins();
        const plugins = await Promise.all(
          Object.values(installed).map(async (metadata) =>
            versionInfo(
              metadata.id,
              metadata.version,
              await d.getInstallSource(metadata.id)
            )
          )
        );
        return reply.status(200).send({ data: { plugins } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          'PLUGIN_VERSIONS_ERROR',
          'Failed to check plugin versions'
        );
      }
    },

    pluginStore: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<PluginStoreData>> => {
      return reply
        .status(200)
        .send({ data: { plugins: [...CURATED_PLUGINS] } });
    },
  };
}

export const versionsHandlers = createVersionsHandlers();
