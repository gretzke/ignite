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
  PinnedSummary,
} from '@ignite/api';
import type { PathOptions } from '@ignite/plugin-types';
import { ProfileManager } from '../filesystem/ProfileManager.js';
import { ProfileRepoRegistry } from '../filesystem/ProfileRepoRegistry.js';
import { RepoLifecycle } from '../repos/RepoLifecycle.js';
import { RepoService } from '../repos/RepoService.js';
import { PinnedStore } from '../repos/PinnedStore.js';
import { FileSystem } from '../filesystem/FileSystem.js';
import { ErrorCodes } from '../types/errors.js';
import { sendCaughtError } from './utils/errors.js';

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
  repoRegistry: Pick<ProfileRepoRegistry, 'list' | 'save' | 'remove'>;
  lifecycle: Pick<
    RepoLifecycle,
    'startLifecycle' | 'activeJobFor' | 'ensureProfileSwept' | 'sessionState'
  >;
  // Cheap host check for the list endpoint's `initialized` field.
  hasWorkspace: (pathOrUrl: string, profileId: string) => Promise<boolean>;
  pinnedStore: Pick<PinnedStore, 'list' | 'remove' | 'worktreePath'>;
  deleteWorktree: (worktreePath: string) => Promise<void>;
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
    pinnedStore: deps?.pinnedStore ?? new PinnedStore(),
    deleteWorktree:
      deps?.deleteWorktree ??
      ((worktreePath: string) => FileSystem.getInstance().deleteDirectory(worktreePath)),
  };

  // Enrich a persisted record with computed state for the list response.
  const enrich = async (
    record: RepoRecord,
    profileId: string
  ): Promise<RepoListEntry> => ({
    ...record,
    initialized: await d.hasWorkspace(record.pathOrUrl, profileId),
    activeJobId: d.lifecycle.activeJobFor(record.pathOrUrl),
  });

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
        const data: RepoList = {
          session: sessionRecord ? await enrich(sessionRecord, id) : null,
          local: await Promise.all(local.map((r) => enrich(r, id))),
          cloned: await Promise.all(cloned.map((r) => enrich(r, id))),
          pinned: (await d.pinnedStore.list(id)).map((record): PinnedSummary => ({
            url: record.url,
            commit: record.commit,
            ...(record.refLabel ? { refLabel: record.refLabel } : {}),
            ...(record.refKind ? { refKind: record.refKind } : {}),
            ...(record.frameworks ? {
              frameworks: record.frameworks.map(({ id: frameworkId, name }) => ({ id: frameworkId, name })),
            } : {}),
            ...(record.detectedAt ? { detectedAt: record.detectedAt } : {}),
            ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
          })),
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
      const worktreePath = d.pinnedStore.worktreePath(id, url, commit);
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
        await d.deleteWorktree(worktreePath);
        await d.pinnedStore.remove(id, url, commit);
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
  };
}

// Production wiring — same exported name as before, so route registration in
// core/src/api/index.ts is untouched.
export const profileHandlers = createProfileHandlers();
