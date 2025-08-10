// Schema utilities for type-safe Zod schema creation
import { z } from "zod";
import type { ApiError, ApiResponse } from "@ignite/plugin-types/types";

// Type-safe ApiError schema that enforces interface compliance
export const ApiErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  details: z.record(z.any()).optional(),
}) satisfies z.ZodType<ApiError>;

/**
 * Creates a type-safe request schema that enforces the schema matches the interface.
 * Provides detailed error messages about missing or incorrect fields.
 *
 * Usage:
 * interface MyRequest { name: string; age: number; }
 * const MyRequestSchema = createRequestSchema<MyRequest>()(z.object({
 *   name: z.string(),
 *   age: z.number(),
 * }));
 */
export function createRequestSchema<T>() {
  return <S extends z.ZodSchema<T>>(schema: S) => schema;
}

/**
 * Creates a type-safe ApiResponse schema that enforces the data schema matches the interface.
 * Provides detailed error messages about missing or incorrect fields.
 *
 * Usage:
 * interface MyData { name: string; age: number; }
 * const MyApiResponseSchema = createApiResponseSchema<MyData>()(z.object({
 *   name: z.string(),
 *   age: z.number(),
 * }));
 */
export function createApiResponseSchema<T>() {
  return <S extends z.ZodSchema<T>>(dataSchema: S) => {
    return z.object({
      success: z.boolean(),
      data: dataSchema.optional(),
      error: ApiErrorSchema.optional(),
    }) satisfies z.ZodType<ApiResponse<T>>;
  };
}
