// Schema utilities for type-safe Zod schema creation
import { z } from "zod";
import type { IApiError, IApiResponse, SuccessResponse } from "../v1/index.js";

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
export function createRequestSchema<T>(id: string) {
  return <S extends z.ZodSchema<T>>(schema: S) => {
    z.globalRegistry.add(schema, { id });
    return schema;
  };
}

/**
 * Creates a type-safe IApiResponse schema that enforces the data schema matches the interface.
 * Provides detailed error messages about missing or incorrect fields.
 *
 * Usage:
 * interface MyData { name: string; age: number; }
 * const MyApiResponseSchema = createApiResponseSchema<MyData>()(z.object({
 *   name: z.string(),
 *   age: z.number(),
 * }));
 */
// Error schema aligned with IApiError
const StatusCodeSchema = z.union([
  z.literal(400),
  z.literal(401),
  z.literal(403),
  z.literal(404),
  z.literal(409),
  z.literal(422),
  z.literal(500),
]);

export const ApiErrorSchema = z.object({
  statusCode: StatusCodeSchema,
  code: z.string(),
  error: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<IApiError>;

// Register a stable id for the error schema so it appears in components
z.globalRegistry.add(ApiErrorSchema, { id: "IApiError" });

export function createApiResponseSchema<T>(id: string) {
  return <S extends z.ZodSchema<T>>(dataSchema: S) => {
    const successSchema = z.object({
      data: dataSchema,
    }) as unknown as z.ZodType<SuccessResponse<T>>;

    const responseSchema = z.union([
      successSchema,
      ApiErrorSchema,
    ]) satisfies z.ZodType<IApiResponse<T>>;

    z.globalRegistry.add(responseSchema, { id });

    return responseSchema as unknown as z.ZodType<IApiResponse<T>>;
  };
}
