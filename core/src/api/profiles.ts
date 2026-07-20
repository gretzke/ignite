// Profile route handlers — thin HTTP↔domain translation only.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiResponse,
  JobStartedData,
  RepoRecord,
  RepoListEntry,
  ListProfilesData,
  GetCurrentProfileData,
  CreateProfileRequest,
  CreateProfileData,
  GetProfileData,
  SwitchProfileData,
  UpdateProfileRequest,
  UpdateProfileData,
  ArchiveProfileData,
  RestoreProfileData,
  DeleteProfileData,
  ProfileConfig,
  ProfileParams,
  RepoList,
  RepoVersionSummary,
  AddRepoVersionRequest,
  AddRepoVersionStartedData,
  RemoveRepoVersionRequest,
  InspectGitRemoteData,
  JobRecord,
} from '@ignite/api';
import type { PathOptions } from '@ignite/plugin-types';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { RepoLifecycle } from '../repos/RepoLifecycle.js';
import {
  RepoService,
  RepoKind,
  deriveRepoKind,
  type VersionSource,
} from '../repos/RepoService.js';
import {
  assertNoUrlCredentials,
  VersionStore,
  canonicalGitUrl,
  pinnedOrigin,
  type VersionRecord,
} from '../repos/VersionStore.js';
import { ErrorCodes } from '../types/errors.js';
import { sendCaughtError } from './utils/errors.js';
import { JobManager, type JobContext } from '../jobs/JobManager.js';
import { inspectGitRemote } from '../plugins/install/gitRemote.js';
import { getLogger } from '../utils/logger.js';

// The subset of ProfileManager the handlers use (tests pass fakes).
export interface ProfileManagerLike {
  getCurrentProfile(): string;
  getCurrentProfileConfig(): Promise<ProfileConfig>;
  getProfileConfig(id: string): Promise<ProfileConfig>;
  listProfiles(): Promise<ProfileConfig[]>;
  listArchivedProfiles(): Promise<ProfileConfig[]>;
  createProfile(
    name: string,
    options?: { color?: string; icon?: string }
  ): Promise<ProfileConfig>;
  switchProfile(id: string): Promise<void>;
  updateProfile(
    id: string,
    updates: { name?: string; color?: string; icon?: string }
  ): Promise<ProfileConfig>;
  archiveProfile(id: string): Promise<void>;
  restoreProfile(id: string): Promise<void>;
  deleteProfile(id: string): Promise<void>;
}

export interface ProfileHandlerDeps {
  getProfileManager: () => Promise<ProfileManagerLike>;
  repoRegistry: Pick<
    ProfileRepoRegistry,
    'list' | 'save' | 'remove' | 'updateRepoState'
  >;
  lifecycle: Pick<
    RepoLifecycle,
    | 'startLifecycle'
    | 'activeJobFor'
    | 'ensureProfileSwept'
    | 'sessionState'
    | 'runPinnedLifecycle'
    | 'beginPinnedActivity'
  >;
  // Cheap host check for the list endpoint's `initialized` field.
  hasWorkspace: (pathOrUrl: string, profileId: string) => Promise<boolean>;
  versionStore: Pick<
    VersionStore,
    | 'removeUserMembershipAndDeleteIfUnreferenced'
    | 'checkoutPath'
    | 'list'
    | 'listMemberships'
    | 'isOriginApproved'
    | 'addMembership'
    | 'updateState'
  >;
  repos: Pick<
    RepoService,
    | 'removeVersionCheckout'
    | 'getVersionSource'
    | 'resolveLocalVersionCommit'
    | 'resolveCachedVersionCommit'
    | 'ensureVersion'
  > & { withVersionMaterialized?: RepoService['withVersionMaterialized'] };
  jobs: Pick<JobManager, 'start'> & { get?: (id: string) => JobRecord | undefined };
  inspectGitRemote: (url: string) => Promise<InspectGitRemoteData>;
  pendingVersionAdds: Map<string, PendingVersionAdd>;
}

export interface PendingVersionAdd {
  jobId: string;
  url: string;
  fetchUrl?: string;
  commit: string;
  refLabel?: string;
  refKind?: 'branch' | 'tag' | 'commit';
  startedAt: string;
}

function pendingKey(profileId: string, url: string, commit: string): string {
  return `${profileId}\u0000${canonicalGitUrl(url)}\u0000${commit}`;
}

function jobIsActive(record: JobRecord | undefined): boolean {
  return Boolean(record && record.state !== 'succeeded' && record.state !== 'failed' && record.state !== 'cancelled');
}

function versionSummary(
  record: VersionRecord,
  activeJobId?: string
): RepoVersionSummary {
  return {
    url: record.url,
    commit: record.commit,
    ...(record.refLabel ? { refLabel: record.refLabel } : {}),
    ...(record.refKind ? { refKind: record.refKind } : {}),
    ...(record.frameworks ? { frameworks: record.frameworks } : {}),
    ...(activeJobId ? { activeJobId } : {}),
    lastUsedAt: record.lastUsedAt,
    ...(record.localFallback ? { localFallback: true } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  };
}

function remoteRef(
  inspected: InspectGitRemoteData,
  ref: string,
  preferredKind?: 'tag' | 'branch'
): { commit: string; refKind: 'branch' | 'tag'; refLabel: string; ambiguous?: boolean } | undefined {
  const branch = ref.replace(/^refs\/heads\//, '');
  const branchCommit = inspected.branchHeads?.[branch];
  const tag = ref.replace(/^refs\/tags\//, '');
  const tagCommit =
    inspected.tagHeads?.[tag] ??
    inspected.releases.find((release) => release.tag === tag)?.sha;
  const ambiguous = Boolean(branchCommit && tagCommit);
  if (preferredKind === 'tag' && tagCommit)
    return { commit: tagCommit, refKind: 'tag', refLabel: tag, ambiguous };
  if (preferredKind === 'branch' && branchCommit)
    return { commit: branchCommit, refKind: 'branch', refLabel: branch, ambiguous };
  if (branchCommit)
    return { commit: branchCommit, refKind: 'branch', refLabel: branch, ambiguous };
  if (tagCommit) return { commit: tagCommit, refKind: 'tag', refLabel: tag };
  return undefined;
}

export function createProfileHandlers(deps?: Partial<ProfileHandlerDeps>) {
  const d: ProfileHandlerDeps = {
    getProfileManager:
      deps?.getProfileManager ?? (() => ProfileManager.getInstance()),
    repoRegistry: deps?.repoRegistry ?? new ProfileRepoRegistry(),
    lifecycle: deps?.lifecycle ?? RepoLifecycle.getInstance(),
    hasWorkspace:
      deps?.hasWorkspace ??
      ((pathOrUrl: string, profileId: string) =>
        RepoService.getInstance().hasWorkspace(pathOrUrl, profileId)),
    versionStore: deps?.versionStore ?? new VersionStore(),
    repos: deps?.repos ?? RepoService.getInstance(),
    jobs: deps?.jobs ?? JobManager.getInstance(),
    inspectGitRemote: deps?.inspectGitRemote ?? inspectGitRemote,
    pendingVersionAdds: deps?.pendingVersionAdds ?? new Map(),
  };
  const originBackfillCache = new Map<string, string>();

  const markVersionFailure = async (
    url: string,
    commit: string,
    record: JobRecord
  ): Promise<void> => {
    const cancelled = record.state === 'cancelled';
    await d.versionStore.updateState(url, commit, {
      lastError: {
        code: cancelled ? 'CANCELLED' : record.error?.code ?? ErrorCodes.OPERATION_EXECUTION_FAILED,
        message: cancelled ? 'Version add was cancelled' : record.error?.message ?? 'Version add failed',
        at: record.finishedAt ?? new Date().toISOString(),
      },
    });
  };

  // Enrich a persisted record with computed state for the list response.
  const enrich = async (
    record: RepoRecord,
    profileId: string,
    versions: RepoVersionSummary[] = [],
    originUrl?: string
  ): Promise<RepoListEntry> => {
    // originUrl is a durable grouping key, not always an exposed remote.
    // In particular file: origins attach local versions but stay hidden from
    // the version-picker response contract.
    const { originUrl: _storedOrigin, ...visibleRecord } = record;
    return {
      ...visibleRecord,
      initialized: await d.hasWorkspace(record.pathOrUrl, profileId),
      activeJobId: d.lifecycle.activeJobFor(record.pathOrUrl),
      ...(originUrl ? { originUrl } : {}),
      versions,
    };
  };

  return {
    listProfiles: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<ListProfilesData>> => {
      try {
        const manager = await d.getProfileManager();
        const currentId = manager.getCurrentProfile();
        const profiles = await manager.listProfiles();
        return reply.status(200).send({ data: { currentId, profiles } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_LIST_ERROR,
          'Failed to list profiles'
        );
      }
    },

    listArchivedProfiles: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<{ profiles: ProfileConfig[] }>> => {
      try {
        const manager = await d.getProfileManager();
        const profiles = await manager.listArchivedProfiles();
        return reply.status(200).send({ data: { profiles } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_ARCHIVE_LIST_ERROR,
          'Failed to list archived profiles'
        );
      }
    },

    getCurrentProfile: async (
      _request: FastifyRequest,
      reply: FastifyReply
    ): Promise<IApiResponse<GetCurrentProfileData>> => {
      try {
        const manager = await d.getProfileManager();
        const name = manager.getCurrentProfile();
        const config = await manager.getCurrentProfileConfig();
        return reply.status(200).send({ data: { name, config } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_GET_ERROR,
          'Failed to get current profile'
        );
      }
    },

    getProfile: async (
      request: FastifyRequest<{ Params: ProfileParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetProfileData>> => {
      try {
        const { id } = request.params;
        const manager = await d.getProfileManager();
        const profile = await manager.getProfileConfig(id);
        return reply.status(200).send({ data: { profile } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_GET_ERROR,
          'Failed to get profile'
        );
      }
    },

    createProfile: async (
      request: FastifyRequest<{ Body: CreateProfileRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<CreateProfileData>> => {
      try {
        const { name, color, icon } = request.body;
        const manager = await d.getProfileManager();
        const profile = await manager.createProfile(name, { color, icon });
        return reply.status(200).send({ data: { profile } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_CREATE_ERROR,
          'Failed to create profile'
        );
      }
    },

    switchProfile: async (
      request: FastifyRequest<{ Params: ProfileParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<SwitchProfileData>> => {
      try {
        const { id } = request.params;
        const manager = await d.getProfileManager();
        await manager.switchProfile(id);
        // Lazy per-profile sweep: first switch to a profile this CLI run
        // initializes+detects its repos in the background; later switches
        // are no-ops (fire-and-forget — the UI attaches via the jobs WS).
        d.lifecycle.ensureProfileSwept(id);
        return reply
          .status(200)
          .send({ data: { message: `Switched to profile '${id}'` } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_SWITCH_ERROR,
          'Failed to switch profile'
        );
      }
    },

    updateProfile: async (
      request: FastifyRequest<{ Body: UpdateProfileRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<UpdateProfileData>> => {
      try {
        const { id, ...updates } = request.body;
        const manager = await d.getProfileManager();
        const profile = await manager.updateProfile(id, updates);
        return reply.status(200).send({ data: { profile } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_UPDATE_ERROR,
          'Failed to update profile'
        );
      }
    },

    archiveProfile: async (
      request: FastifyRequest<{ Params: ProfileParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ArchiveProfileData>> => {
      try {
        const { id } = request.params;
        const manager = await d.getProfileManager();
        await manager.archiveProfile(id);
        return reply
          .status(200)
          .send({ data: { message: `Archived profile '${id}'` } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_ARCHIVE_ERROR,
          'Failed to archive profile'
        );
      }
    },

    restoreProfile: async (
      request: FastifyRequest<{ Params: ProfileParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<RestoreProfileData>> => {
      try {
        const { id } = request.params;
        const manager = await d.getProfileManager();
        await manager.restoreProfile(id);
        const profile = await manager.getProfileConfig(id);
        return reply.status(200).send({ data: { profile } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_RESTORE_ERROR,
          'Failed to restore profile'
        );
      }
    },

    deleteProfile: async (
      request: FastifyRequest<{ Params: ProfileParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<DeleteProfileData>> => {
      try {
        const { id } = request.params;
        const manager = await d.getProfileManager();
        await manager.deleteProfile(id);
        return reply
          .status(200)
          .send({ data: { message: `Deleted profile '${id}'` } });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_DELETE_ERROR,
          'Failed to delete profile'
        );
      }
    },

    // === Repo registry endpoints (per profile) ===
    listRepos: async (
      request: FastifyRequest<{ Params: ProfileParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<RepoList>> => {
      try {
        const { id } = request.params;
        const { local, cloned } = await d.repoRegistry.list(id);
        const sessionRecord = d.lifecycle.sessionState();
        const records = [
          ...(sessionRecord ? [sessionRecord] : []),
          ...local,
          ...cloned,
        ];
        const [memberships, versions] = await Promise.all([
          d.versionStore.listMemberships(id),
          d.versionStore.list(),
        ]);
        const recordsByKey = new Map(
          versions.map((record) => [
            `${record.url}\u0000${record.commit}`,
            record,
          ])
        );
        const versionsByUrl = new Map<string, RepoVersionSummary[]>();
        const projected = new Set<string>();
        for (const [url, entries] of Object.entries(memberships)) {
          const summaries: RepoVersionSummary[] = [];
          const seen = new Set<string>();
          for (const entry of entries) {
            if (seen.has(entry.commit)) continue;
            const record = recordsByKey.get(`${url}\u0000${entry.commit}`);
            if (!record) continue;
            seen.add(entry.commit);
            summaries.push(
              versionSummary(
                record,
                d.lifecycle.activeJobFor(
                  d.versionStore.checkoutPath(record.url, record.commit)
                )
              )
            );
            projected.add(`${canonicalGitUrl(record.url)}\u0000${record.commit}`);
          }
          if (summaries.length > 0) versionsByUrl.set(url, summaries);
        }
        for (const [key, pending] of d.pendingVersionAdds) {
          if (!key.startsWith(`${id}\u0000`)) continue;
          if (!jobIsActive(d.jobs.get?.(pending.jobId))) continue;
          const canonicalUrl = canonicalGitUrl(pending.url);
          const versionKey = `${canonicalUrl}\u0000${pending.commit}`;
          if (projected.has(versionKey)) continue;
          const summaries = versionsByUrl.get(canonicalUrl) ?? [];
          summaries.push({
            url: canonicalUrl,
            commit: pending.commit,
            ...(pending.refLabel ? { refLabel: pending.refLabel } : {}),
            ...(pending.refKind ? { refKind: pending.refKind } : {}),
            activeJobId: pending.jobId,
            lastUsedAt: pending.startedAt,
          });
          versionsByUrl.set(canonicalUrl, summaries);
          projected.add(versionKey);
        }

        // Group by durable origins. Legacy records get a bounded live probe;
        // a successful one is cached and persisted without delaying the reply.
        // The exposed response still suppresses file: origins, but file: is a
        // real grouping identity so remoteless local repos retain their pins.
        const origins = new Map<string, string | undefined>();
        await Promise.all(
          records.map(async (record) => {
            if (record.originUrl) {
              origins.set(record.pathOrUrl, record.originUrl);
              return;
            }
            const cacheKey = `${id}\u0000${record.pathOrUrl}`;
            const cached = originBackfillCache.get(cacheKey);
            if (cached) {
              origins.set(record.pathOrUrl, cached);
              return;
            }
            const source = d.repos
              .getVersionSource(record.pathOrUrl, id)
              .then((value) => canonicalGitUrl(value.url))
              .catch(() => undefined);
            void source.then((originUrl) => {
              if (!originUrl) return;
              originBackfillCache.set(cacheKey, originUrl);
              if (sessionRecord?.pathOrUrl === record.pathOrUrl) return;
              void d.repoRegistry
                .updateRepoState(id, record.pathOrUrl, { originUrl })
                .catch((error) => {
                  getLogger().warn(
                    `Failed to persist origin backfill for '${record.pathOrUrl}': ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                });
            });
            const originUrl = await Promise.race([
              source,
              new Promise<undefined>((resolve) =>
                setTimeout(() => resolve(undefined), 3_000)
              ),
            ]);
            origins.set(
              record.pathOrUrl,
              originUrl ??
                (deriveRepoKind(record.pathOrUrl) === RepoKind.CLONED
                  ? canonicalGitUrl(record.pathOrUrl)
                  : undefined)
            );
          })
        );
        const matchedUrls = new Set(
          [...origins.values()].filter((url): url is string => Boolean(url))
        );
        const withVersions = (record: RepoRecord) =>
          enrich(
            record,
            id,
            versionsByUrl.get(origins.get(record.pathOrUrl) ?? '') ?? [],
            // A file URL is the deliberate fallback for a local repository
            // without an origin. It must not be presented as a remote picker.
            origins.get(record.pathOrUrl)?.startsWith('file:')
              ? undefined
              : origins.get(record.pathOrUrl)
          );
        const data: RepoList = {
          session: sessionRecord ? await withVersions(sessionRecord) : null,
          local: await Promise.all(local.map(withVersions)),
          cloned: await Promise.all(cloned.map(withVersions)),
          versionGroups: [...versionsByUrl.entries()]
            .filter(([url]) => !matchedUrls.has(url))
            .map(([url, groupedVersions]) => ({
              url,
              versions: groupedVersions,
            })),
          // Deprecated response-shape compatibility field.
          pinned: [],
        };
        return reply.status(200).send({ data });
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_REPOS_LIST_ERROR,
          'Failed to list profile repositories'
        );
      }
    },

    saveRepo: async (
      request: FastifyRequest<{ Params: ProfileParams; Body: PathOptions }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      try {
        await d.repoRegistry.save(request.params.id, request.body.pathOrUrl);
        // Adding a repo runs the full pipeline: init -> detect -> install ->
        // compile -> fingerprint (every detected framework, local + cloned).
        const job = d.lifecycle.startLifecycle(
          request.body.pathOrUrl,
          request.params.id,
          'add'
        );
        return reply.status(200).send({ data: { jobId: job.id } });
      } catch (error) {
        // Saving an identity that's already registered is a client conflict,
        // not a server fault.
        if (
          (error as { code?: string })?.code === ErrorCodes.REPO_ALREADY_EXISTS
        ) {
          return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            code: ErrorCodes.REPO_ALREADY_EXISTS,
            message: error instanceof Error ? error.message : String(error),
          }) as unknown as IApiResponse<JobStartedData>;
        }
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_REPO_SAVE_ERROR,
          'Failed to save repository to profile'
        ) as unknown as IApiResponse<JobStartedData>;
      }
    },

    deleteRepo: async (
      request: FastifyRequest<{
        Params: ProfileParams;
        Querystring: PathOptions;
      }>,
      reply: FastifyReply
    ): Promise<null> => {
      try {
        await d.repoRegistry.remove(request.params.id, request.query.pathOrUrl);
        return reply.status(204).send(null);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_REPO_DELETE_ERROR,
          'Failed to delete repository from profile'
        ) as unknown as null;
      }
    },

    deletePinnedRepo: async (
      request: FastifyRequest<{
        Params: ProfileParams;
        Querystring: { url: string; commit: string };
      }>,
      reply: FastifyReply
    ): Promise<null> => {
      const { id } = request.params;
      const { url, commit } = request.query;
      const worktreePath = d.versionStore.checkoutPath(url, commit);
      if (d.lifecycle.activeJobFor(worktreePath)) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          code: ErrorCodes.REPO_BUSY,
          message: 'Pinned repository is busy',
          details: { url, commit },
        }) as unknown as null;
      }
      try {
        let busy = false;
        await d.repos.removeVersionCheckout(url, commit, (deleteLocked) => {
          if (d.lifecycle.activeJobFor(worktreePath)) {
            busy = true;
            return Promise.resolve(false);
          }
          return d.versionStore.removeUserMembershipAndDeleteIfUnreferenced(id, url, commit, deleteLocked);
        });
        if (busy) return reply.status(409).send({ statusCode: 409, error: 'Conflict', code: ErrorCodes.REPO_BUSY, message: 'Pinned repository is busy', details: { url, commit } }) as unknown as null;
        return reply.status(204).send(null);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_REPO_DELETE_ERROR,
          'Failed to delete pinned repository from profile'
        ) as unknown as null;
      }
    },

    addRepoVersion: async (
      request: FastifyRequest<{
        Params: ProfileParams;
        Body: AddRepoVersionRequest;
      }>,
      reply: FastifyReply
    ): Promise<IApiResponse<AddRepoVersionStartedData>> => {
      try {
        const { id } = request.params;
        const body = request.body;
        if (body.url) assertNoUrlCredentials(body.url);
        const source: VersionSource = body.repoPathOrUrl
          ? await d.repos.getVersionSource(body.repoPathOrUrl, id)
          : { url: body.url!, workspacePath: '' };
        assertNoUrlCredentials(source.url);
        if (source.fetchUrl) assertNoUrlCredentials(source.fetchUrl);
        if (!(await d.versionStore.isOriginApproved(id, source.url))) {
          return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            code: ErrorCodes.VERSION_ORIGIN_UNAPPROVED,
            message: 'Version origin approval required',
            details: { origins: [pinnedOrigin(source.url)] },
          }) as unknown as IApiResponse<AddRepoVersionStartedData>;
        }
        const resolved = body.ref
          ? source.localFallbackPath
            ? {
                ...(await d.repos.resolveLocalVersionCommit(
                  body.repoPathOrUrl!,
                  body.ref,
                  id
                )),
                refLabel: body.ref,
              }
          : remoteRef(await d.inspectGitRemote(source.url), body.ref, body.refKind)
          : {
              commit: body.commit!,
              refKind: 'commit' as const,
              refLabel: body.commit!,
            };
        if (!resolved)
          return reply.status(400).send({
            statusCode: 400,
            error: 'Bad Request',
            code: 'VERSION_REF_NOT_FOUND',
            message: `Remote ref '${body.ref}' was not found`,
          }) as unknown as IApiResponse<AddRepoVersionStartedData>;
        let { commit, refKind, refLabel } = resolved;
        // The API accepts a convenient short SHA, but VersionStore identities
        // are always full commits. Prefer advertised heads, then use cached
        // bare history for a valid historical commit.
        if (commit.length < 40) {
          const heads = await d.inspectGitRemote(source.url);
          const matches = [...Object.values(heads.branchHeads ?? {}), ...Object.values(heads.tagHeads ?? {})]
            .filter((sha, index, all) => sha.toLowerCase().startsWith(commit.toLowerCase()) && all.indexOf(sha) === index);
          if (matches.length === 1) {
            const cached = await d.repos.resolveCachedVersionCommit(source.url, commit);
            if (cached && cached.toLowerCase() !== matches[0].toLowerCase()) {
              return reply.status(400).send({
                statusCode: 400,
                error: 'Bad Request',
                code: 'VERSION_COMMIT_AMBIGUOUS',
                message: `Commit prefix '${commit}' is ambiguous in cached history. Provide more characters.`,
              }) as unknown as IApiResponse<AddRepoVersionStartedData>;
            }
            commit = matches[0];
          }
          else {
            const cached = await d.repos.resolveCachedVersionCommit(source.url, commit);
            if (!cached) {
              return reply.status(400).send({ statusCode: 400, error: 'Bad Request', code: 'VERSION_COMMIT_NOT_RESOLVABLE', message: `Commit prefix '${commit}' is not available in cached history. Provide the full 40-hex commit for commits not at a ref head.` }) as unknown as IApiResponse<AddRepoVersionStartedData>;
            }
            commit = cached;
          }
          refLabel = commit;
        }
        const key = pendingKey(id, source.url, commit);
        const existing = d.pendingVersionAdds.get(key);
        if (existing && jobIsActive(d.jobs.get?.(existing.jobId))) {
          return reply.status(200).send({
            data: { jobId: existing.jobId, url: source.url, commit },
          });
        }
        let releaseActivity: () => void = () => {};
        const job = d.jobs.start(
          'repo.version.add',
          { url: source.url, commit, ref: body.ref },
          async (ctx: JobContext) => {
            try {
              if ('ambiguous' in resolved && resolved.ambiguous && !body.refKind)
                ctx.log(`warning: ref '${body.ref}' matches both a branch and tag; using branch\n`);
              const withMaterialized = d.repos.withVersionMaterialized?.bind(d.repos) ?? (async <T>(profileId: string, url: string, versionCommit: string, opts: Parameters<RepoService['withVersionMaterialized']>[3], fn: Parameters<RepoService['withVersionMaterialized']>[4]): Promise<T> => {
                await d.repos.ensureVersion(profileId, url, versionCommit, opts);
                return fn({ checkout: d.versionStore.checkoutPath(url, versionCommit), rematerialize: () => d.repos.ensureVersion(profileId, url, versionCommit, opts) }) as Promise<T>;
              });
              ctx.log('phase: materialize\n');
              return await withMaterialized(
                id, source.url, commit,
                { ...(body.ref ? { ref: body.ref, refLabel, refKind } : {}), ...(source.localFallbackPath ? { localFallbackPath: source.localFallbackPath } : {}), onLog: (text) => ctx.log(text), signal: ctx.signal },
                async (materialized) => {
                  if (ctx.signal.aborted) throw ctx.signal.reason;
                  ctx.log('phase: add user membership\n');
                  await d.versionStore.addMembership(id, source.url, commit, 'user');
                  ctx.log('phase: detect and compile\n');
                  return d.lifecycle.runPinnedLifecycle(source.url, commit, id, ctx, materialized, true);
                }
              );
            } finally {
              releaseActivity();
            }
          },
          {
            onSettled: (record) => {
              d.pendingVersionAdds.delete(key);
              if (!record.startedAt) releaseActivity();
              if (record.state === 'failed' || record.state === 'cancelled') {
                return markVersionFailure(source.url, commit, record).catch((error) =>
                  getLogger().warn(`version failure persist: ${String(error)}`)
                );
              }
            },
          }
        );
        releaseActivity = d.lifecycle.beginPinnedActivity(source.url, commit, job.id);
        d.pendingVersionAdds.set(key, {
          jobId: job.id,
          url: canonicalGitUrl(source.url),
          ...(source.fetchUrl ? { fetchUrl: source.fetchUrl } : {}),
          commit,
          ...(refLabel ? { refLabel } : {}),
          ...(refKind ? { refKind } : {}),
          startedAt: new Date().toISOString(),
        });
        return reply.status(200).send({
          data: { jobId: job.id, url: source.url, commit },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'VERSION_URL_CREDENTIALS') {
          return reply.status(400).send({
            statusCode: 400,
            error: 'Bad Request',
            code: 'VERSION_URL_CREDENTIALS',
            message: 'Version URLs must not embed credentials',
          }) as unknown as IApiResponse<AddRepoVersionStartedData>;
        }
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_REPO_SAVE_ERROR,
          'Failed to add repository version'
        ) as unknown as IApiResponse<AddRepoVersionStartedData>;
      }
    },

    removeRepoVersion: async (
      request: FastifyRequest<{
        Params: ProfileParams;
        Body: RemoveRepoVersionRequest;
      }>,
      reply: FastifyReply
    ): Promise<null> => {
      const { id } = request.params;
      const { url, commit } = request.body;
      const checkout = d.versionStore.checkoutPath(url, commit);
      if (d.lifecycle.activeJobFor(checkout)) {
        return reply.status(409).send({
          statusCode: 409,
          error: 'Conflict',
          code: ErrorCodes.REPO_BUSY,
          message: 'Repository version is busy',
          details: { url, commit },
        }) as unknown as null;
      }
      try {
        let busy = false;
        const deleted = await d.repos.removeVersionCheckout(
          url,
          commit,
          (deleteLocked) => {
            if (d.lifecycle.activeJobFor(checkout)) {
              busy = true;
              return Promise.resolve(false);
            }
            return d.versionStore.removeUserMembershipAndDeleteIfUnreferenced(id, url, commit, deleteLocked);
          }
        );
        if (busy) {
          return reply.status(409).send({ statusCode: 409, error: 'Conflict', code: ErrorCodes.REPO_BUSY, message: 'Repository version is busy', details: { url, commit } }) as unknown as null;
        }
        if (!deleted) {
          return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            code: ErrorCodes.VERSION_IN_USE,
            message:
              'Repository version is still referenced by a workflow or another profile',
            details: { url, commit },
          }) as unknown as null;
        }
        return reply.status(204).send(null);
      } catch (error) {
        return sendCaughtError(
          reply,
          error,
          ErrorCodes.PROFILE_REPO_DELETE_ERROR,
          'Failed to remove repository version'
        ) as unknown as null;
      }
    },
  };
}

// Production wiring — same exported name as before, so route registration in
// core/src/api/index.ts is untouched.
export const profileHandlers = createProfileHandlers();
