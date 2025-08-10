// Profile management routes
import { z } from "zod";
import type { ApiResponse } from "@ignite/plugin-types/types";
import { V1_BASE_PATH } from "./index.js";
import { createApiResponseSchema } from "../utils/schema.js";

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

// API Response interfaces using the ApiResponse wrapper
export interface ListProfilesResponse extends ApiResponse<ListProfilesData> {}
export interface GetCurrentProfileResponse
  extends ApiResponse<GetCurrentProfileData> {}
export interface CreateProfileResponse extends ApiResponse<CreateProfileData> {}
export interface SwitchProfileResponse extends ApiResponse<SwitchProfileData> {}

// Type-safe ApiResponse schemas that enforce interface compliance
export const ListProfilesResponseSchema =
  createApiResponseSchema<ListProfilesData>()(
    z.object({
      profiles: z.array(z.string()),
    }),
  );

export const GetCurrentProfileResponseSchema =
  createApiResponseSchema<GetCurrentProfileData>()(
    z.object({
      name: z.string(),
      config: z.any().optional(), // TODO: Define proper profile config schema
    }),
  );

export const CreateProfileRequestSchema = z.object({
  name: z.string(),
});

export const CreateProfileResponseSchema =
  createApiResponseSchema<CreateProfileData>()(
    z.object({
      message: z.string(),
    }),
  );

export const SwitchProfileRequestSchema = z.object({
  name: z.string(),
});

export const SwitchProfileResponseSchema =
  createApiResponseSchema<SwitchProfileData>()(
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
      response: {
        200: ListProfilesResponseSchema,
      },
    },
  },
  getCurrentProfile: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/profiles/current`,
    schema: {
      response: {
        200: GetCurrentProfileResponseSchema,
      },
    },
  },
  createProfile: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/profiles`,
    schema: {
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
      body: SwitchProfileRequestSchema,
      response: {
        200: SwitchProfileResponseSchema,
      },
    },
  },
} as const;
