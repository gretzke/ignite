// Profile management routes
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";
import { PathRequestSchema } from "./shared.js";
import { JobStartedResponseSchema } from "./jobs.js";

export interface ProfileParams {
  id: string;
}

// Interface definitions first
export interface ProfileConfig {
  id: string;
  name: string;
  color: string; // hex string, e.g. "#627eeb"
  icon: string; // emoji or letter, may be empty string
  created: string; // ISO timestamp
  lastUsed: string; // ISO timestamp
}

export interface ListProfilesData {
  currentId: string;
  profiles: ProfileConfig[];
}

export interface GetCurrentProfileData {
  name: string;
  config?: ProfileConfig;
}

export interface CreateProfileRequest {
  name: string;
  color?: string;
  icon?: string;
}

export interface CreateProfileData {
  profile: ProfileConfig;
}
export interface GetProfileData {
  profile: ProfileConfig;
}

export interface SwitchProfileData {
  message: string;
}

export interface UpdateProfileRequest {
  id: string;
  name?: string;
  color?: string;
  icon?: string;
}

export interface UpdateProfileData {
  profile: ProfileConfig;
}

export interface ArchiveProfileData {
  message: string;
}

export interface RestoreProfileData {
  profile: ProfileConfig;
}

export interface DeleteProfileData {
  message: string;
}

// === Repo registry records (persisted per profile) ===

export interface RepoWatchPaths {
  config: string[]; // e.g. ["foundry.toml", "remappings.txt"]
  sources: string[]; // e.g. ["src", "lib", "test"]
  artifacts: string[]; // e.g. ["out"]
}

export interface RepoFingerprint {
  sources: string; // sha256 hex over config+sources stat-walk
  artifacts: string; // sha256 hex over artifacts stat-walk
}

export interface RepoFrameworkState {
  id: string; // plugin id, e.g. "foundry"
  name: string; // display name from plugin metadata
  watchPaths?: RepoWatchPaths;
  fingerprint?: RepoFingerprint; // captured after last successful compile
  compiledAt?: string; // ISO timestamp of last successful compile
}

export interface RepoRecord {
  pathOrUrl: string;
  frameworks?: RepoFrameworkState[]; // undefined = never detected
  detectedAt?: string;
}

// List entries enrich the persisted record with computed state so the UI
// renders without re-running init/detect cycles.
export interface RepoListEntry extends RepoRecord {
  initialized: boolean;
  activeJobId?: string; // in-flight repo.lifecycle job, if any
  versions: RepoVersionSummary[];
}

export type RepoVersionRefKind = 'tag' | 'branch' | 'commit';

export interface RepoVersionSummary {
  url: string;
  commit: string;
  refLabel?: string;
  refKind?: RepoVersionRefKind;
  frameworks?: RepoFrameworkState[];
  lastUsedAt: string;
  localFallback?: boolean;
}

export interface OrphanVersionGroup {
  url: string;
  versions: RepoVersionSummary[];
}

export interface RepoList {
  session: RepoListEntry | null;
  local: RepoListEntry[];
  cloned: RepoListEntry[];
  versionGroups: OrphanVersionGroup[];
  /** @deprecated Replaced by repo entry versions and versionGroups; kept for response-shape compatibility. */
  pinned: PinnedSummary[];
}

/** @deprecated PinnedStore summaries are replaced by version groups; kept for response-shape compatibility. */
export interface PinnedSummary {
  url: string;
  commit: string;
  refLabel?: string;
  refKind?: 'tag' | 'branch';
  frameworks?: Array<{ id: string; name: string }>;
  detectedAt?: string;
  lastUsedAt?: string;
}

export interface AddRepoVersionRequest {
  url?: string;
  repoPathOrUrl?: string;
  ref?: string;
  refKind?: 'tag' | 'branch';
  commit?: string;
}

export interface RemoveRepoVersionRequest {
  url: string;
  commit: string;
}

export const ProfileParamsSchema = createRequestSchema<ProfileParams>(
  "ProfileParamsSchema",
)(z.object({ id: z.string() }));

// Type-safe IApiResponse schemas that enforce interface compliance
export const ProfileConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  icon: z.string(),
  created: z.string(),
  lastUsed: z.string(),
});

export const ListProfilesResponseSchema =
  createApiResponseSchema<ListProfilesData>("ListProfilesResponseSchema")(
    z.object({
      currentId: z.string(),
      profiles: z.array(ProfileConfigSchema),
    }),
  );

export const ListArchivedProfilesResponseSchema = createApiResponseSchema<{
  profiles: ProfileConfig[];
}>("ListArchivedProfilesResponseSchema")(
  z.object({ profiles: z.array(ProfileConfigSchema) }),
);

export const GetCurrentProfileResponseSchema =
  createApiResponseSchema<GetCurrentProfileData>(
    "GetCurrentProfileResponseSchema",
  )(
    z.object({
      name: z.string(),
      config: ProfileConfigSchema.optional(),
    }),
  );

export const CreateProfileRequestSchema =
  createRequestSchema<CreateProfileRequest>("CreateProfileRequestSchema")(
    z.object({
      name: z.string(),
      color: z.string().optional(),
      icon: z.string().optional(),
    }),
  );

export const CreateProfileResponseSchema =
  createApiResponseSchema<CreateProfileData>("CreateProfileResponseSchema")(
    z.object({
      profile: ProfileConfigSchema,
    }),
  );

export const SwitchProfileResponseSchema =
  createApiResponseSchema<SwitchProfileData>("SwitchProfileResponseSchema")(
    z.object({
      message: z.string(),
    }),
  );

export const GetProfileResponseSchema = createApiResponseSchema<GetProfileData>(
  "GetProfileResponseSchema",
)(z.object({ profile: ProfileConfigSchema }));

export const UpdateProfileRequestSchema =
  createRequestSchema<UpdateProfileRequest>("UpdateProfileRequestSchema")(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      color: z.string().optional(),
      icon: z.string().optional(),
    }),
  );

export const UpdateProfileResponseSchema =
  createApiResponseSchema<UpdateProfileData>("UpdateProfileResponseSchema")(
    z.object({ profile: ProfileConfigSchema }),
  );

export const ArchiveProfileResponseSchema =
  createApiResponseSchema<ArchiveProfileData>("ArchiveProfileResponseSchema")(
    z.object({ message: z.string() }),
  );

export const RestoreProfileResponseSchema =
  createApiResponseSchema<RestoreProfileData>("RestoreProfileResponseSchema")(
    z.object({ profile: ProfileConfigSchema }),
  );

export const DeleteProfileResponseSchema =
  createApiResponseSchema<DeleteProfileData>("DeleteProfileResponseSchema")(
    z.object({ message: z.string() }),
  );

// Profile repository registry schemas
export const RepoWatchPathsSchema = z.object({
  config: z.array(z.string()),
  sources: z.array(z.string()),
  artifacts: z.array(z.string()),
});

export const RepoFrameworkStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  watchPaths: RepoWatchPathsSchema.optional(),
  fingerprint: z
    .object({ sources: z.string(), artifacts: z.string() })
    .optional(),
  compiledAt: z.string().optional(),
});

export const RepoListEntrySchema = z.object({
  pathOrUrl: z.string(),
  frameworks: z.array(RepoFrameworkStateSchema).optional(),
  detectedAt: z.string().optional(),
  initialized: z.boolean(),
  activeJobId: z.string().optional(),
  versions: z.array(
    z.object({
      url: z.string().min(1),
      commit: z.string().regex(/^[0-9a-fA-F]{40}$/),
      refLabel: z.string().optional(),
      refKind: z.enum(['tag', 'branch', 'commit']).optional(),
      frameworks: z.array(RepoFrameworkStateSchema).optional(),
      lastUsedAt: z.string(),
      localFallback: z.boolean().optional(),
    }),
  ).default([]),
});

export const GetReposResponseSchema = createApiResponseSchema<RepoList>(
  "GetReposResponseSchema",
)(
  z.object({
    session: RepoListEntrySchema.nullable(),
    local: z.array(RepoListEntrySchema),
    cloned: z.array(RepoListEntrySchema),
    versionGroups: z.array(z.object({
      url: z.string(),
      versions: z.array(z.object({
        url: z.string().min(1),
        commit: z.string().regex(/^[0-9a-fA-F]{40}$/),
        refLabel: z.string().optional(),
        refKind: z.enum(['tag', 'branch', 'commit']).optional(),
        frameworks: z.array(RepoFrameworkStateSchema).optional(),
        lastUsedAt: z.string(),
        localFallback: z.boolean().optional(),
      })),
    })),
    // Deprecated response-shape compatibility field.
    pinned: z.array(z.object({
      url: z.string(),
      commit: z.string().regex(/^[0-9a-fA-F]{40}$/),
      refLabel: z.string().optional(),
      refKind: z.enum(['tag', 'branch']).optional(),
      frameworks: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      detectedAt: z.string().optional(),
      lastUsedAt: z.string().optional(),
    })),
  }),
);

export const DeleteRepoQuerySchema = z.object({ pathOrUrl: z.string().min(1) });
export const DeletePinnedRepoQuerySchema = z.object({
  url: z.string().min(1),
  commit: z.string().regex(/^[0-9a-fA-F]{40}$/),
});

export const AddRepoVersionRequestSchema =
  createRequestSchema<AddRepoVersionRequest>('AddRepoVersionRequestSchema')(
    z.object({
      url: z.string().min(1).optional(),
      repoPathOrUrl: z.string().min(1).optional(),
      ref: z.string().min(1).optional(),
      refKind: z.enum(['tag', 'branch']).optional(),
      commit: z.string().regex(/^[0-9a-fA-F]{7,40}$/).optional(),
    }).superRefine((value, context) => {
      if ((value.url !== undefined) === (value.repoPathOrUrl !== undefined))
        context.addIssue({ code: 'custom', message: 'Provide exactly one of url or repoPathOrUrl' });
      if ((value.ref !== undefined) === (value.commit !== undefined))
        context.addIssue({ code: 'custom', message: 'Provide exactly one of ref or commit' });
      if (value.refKind !== undefined && value.ref === undefined)
        context.addIssue({ code: 'custom', message: 'refKind requires ref' });
    }),
  );

export const RemoveRepoVersionRequestSchema =
  createRequestSchema<RemoveRepoVersionRequest>('RemoveRepoVersionRequestSchema')(
    z.object({
      url: z.string().min(1),
      commit: z.string().regex(/^[0-9a-fA-F]{40}$/),
    }),
  );

// Route definitions
export const profileRoutes = {
  listProfiles: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/profiles`,
    schema: {
      tags: ["profiles"],
      response: {
        200: ListProfilesResponseSchema,
      },
    },
  },
  listArchivedProfiles: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/profiles/archived`,
    schema: {
      tags: ["profiles"],
      response: {
        200: ListArchivedProfilesResponseSchema,
      },
    },
  },
  getCurrentProfile: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/profiles/current`,
    schema: {
      tags: ["profiles"],
      response: {
        200: GetCurrentProfileResponseSchema,
      },
    },
  },
  getProfile: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/profiles/:id`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      response: {
        200: GetProfileResponseSchema,
      },
    },
  },
  createProfile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/profiles`,
    schema: {
      tags: ["profiles"],
      body: CreateProfileRequestSchema,
      response: {
        200: CreateProfileResponseSchema,
      },
    },
  },
  switchProfile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/profiles/:id/switch`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      response: {
        200: SwitchProfileResponseSchema,
      },
    },
  },
  updateProfile: {
    method: "PUT" as const,
    path: `${V1_BASE_PATH}/profiles`,
    schema: {
      tags: ["profiles"],
      body: UpdateProfileRequestSchema,
      response: {
        200: UpdateProfileResponseSchema,
      },
    },
  },
  archiveProfile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/profiles/:id/archive`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      response: {
        200: ArchiveProfileResponseSchema,
      },
    },
  },
  restoreProfile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/profiles/:id/restore`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      response: {
        200: RestoreProfileResponseSchema,
      },
    },
  },
  deleteProfile: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/profiles/:id`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      response: {
        200: DeleteProfileResponseSchema,
      },
    },
  },
  listRepos: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/profiles/:id/repos`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      response: { 200: GetReposResponseSchema },
    },
  },
  saveRepo: {
    method: "PUT" as const,
    path: `${V1_BASE_PATH}/profiles/:id/repos`,
    params: ProfileParamsSchema,
    schema: {
      tags: ["profiles"],
      body: PathRequestSchema,
      // Saving starts the add-mode lifecycle pipeline (init -> detect ->
      // install -> compile -> fingerprint); the response is that job.
      response: { 200: JobStartedResponseSchema },
    },
  },
  deleteRepo: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/profiles/:id/repos`,
    params: ProfileParamsSchema,
    querystring: DeleteRepoQuerySchema,
    schema: {
      tags: ["profiles"],
      response: { 204: z.null() },
    },
  },
  deletePinnedRepo: {
    method: "DELETE" as const,
    path: `${V1_BASE_PATH}/profiles/:id/repos/pinned`,
    params: ProfileParamsSchema,
    querystring: DeletePinnedRepoQuerySchema,
    schema: {
      tags: ["profiles"],
      response: { 204: z.null() },
    },
  },
  addRepoVersion: {
    method: 'POST' as const,
    path: `${V1_BASE_PATH}/profiles/:id/repos/versions`,
    params: ProfileParamsSchema,
    schema: {
      tags: ['profiles'],
      body: AddRepoVersionRequestSchema,
      response: { 200: JobStartedResponseSchema },
    },
  },
  removeRepoVersion: {
    method: 'DELETE' as const,
    path: `${V1_BASE_PATH}/profiles/:id/repos/versions`,
    params: ProfileParamsSchema,
    schema: {
      tags: ['profiles'],
      body: RemoveRepoVersionRequestSchema,
      response: { 204: z.null() },
    },
  },
} as const;
