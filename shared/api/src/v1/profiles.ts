// Profile management routes
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import {
  createApiResponseSchema,
  createRequestSchema,
} from "../utils/schema.js";

// Interface definitions first
export interface ListProfilesData {
  profiles: string[];
}

export interface GetCurrentProfileData {
  name: string;
  config?: any; // TODO: Define proper profile config type
}

export interface CreateProfileRequest {
  name: string;
}

export interface CreateProfileData {
  message: string;
}

export interface SwitchProfileRequest {
  name: string;
}

export interface SwitchProfileData {
  message: string;
}

// Type-safe ApiResponse schemas that enforce interface compliance
export const ListProfilesResponseSchema =
  createApiResponseSchema<ListProfilesData>("ListProfilesResponseSchema")(
    z.object({
      profiles: z.array(z.string()),
    }),
  );

export const GetCurrentProfileResponseSchema =
  createApiResponseSchema<GetCurrentProfileData>(
    "GetCurrentProfileResponseSchema",
  )(
    z.object({
      name: z.string(),
      config: z.any().optional(), // TODO: Define proper profile config schema
    }),
  );

export const CreateProfileRequestSchema =
  createRequestSchema<CreateProfileRequest>("CreateProfileRequestSchema")(
    z.object({
      name: z.string(),
    }),
  );

export const CreateProfileResponseSchema =
  createApiResponseSchema<CreateProfileData>("CreateProfileResponseSchema")(
    z.object({
      message: z.string(),
    }),
  );

export const SwitchProfileRequestSchema =
  createRequestSchema<SwitchProfileRequest>("SwitchProfileRequestSchema")(
    z.object({
      name: z.string(),
    }),
  );

export const SwitchProfileResponseSchema =
  createApiResponseSchema<SwitchProfileData>("SwitchProfileResponseSchema")(
    z.object({
      message: z.string(),
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
    path: `${V1_BASE_PATH}/profiles/switch`,
    schema: {
      tags: ["profiles"],
      body: SwitchProfileRequestSchema,
      response: {
        200: SwitchProfileResponseSchema,
      },
    },
  },
} as const;
