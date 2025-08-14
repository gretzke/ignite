// Profile management routes
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";

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

// Type-safe ApiResponse schemas that enforce interface compliance
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
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
    params: z.object({ id: z.string() }),
    schema: {
      tags: ["profiles"],
      response: {
        200: DeleteProfileResponseSchema,
      },
    },
  },
} as const;
