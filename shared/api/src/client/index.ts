import { z } from "zod";
import { buildUrl, httpRequest, IApiClientOptions } from "./http.js";
import { v1Routes } from "../v1/index.js";

type InferBodySchema<T> = T extends { schema: { body: infer B } } ? B : never;
type InferQuerySchema<T> = T extends { querystring: infer Q } ? Q : never;
type InferParamsSchema<T> = T extends { params: infer P } ? P : never;
type InferResponseSchema<T> = T extends {
  schema: { response: { 200: infer R } };
}
  ? R
  : never;

export interface Client {
  request<TName extends keyof typeof v1Routes>(
    name: TName,
    args: {
      params?: z.infer<InferParamsSchema<(typeof v1Routes)[TName]>>;
      query?: z.infer<InferQuerySchema<(typeof v1Routes)[TName]>>;
      body?: z.infer<InferBodySchema<(typeof v1Routes)[TName]>>;
      signal?: AbortSignal;
    },
  ): Promise<z.infer<InferResponseSchema<(typeof v1Routes)[TName]>>>;
}

export function createClient(options: IApiClientOptions = {}): Client {
  const { baseUrl, headers } = options;

  async function request<TName extends keyof typeof v1Routes>(
    name: TName,
    args: {
      params?: z.infer<InferParamsSchema<(typeof v1Routes)[TName]>>;
      query?: z.infer<InferQuerySchema<(typeof v1Routes)[TName]>>;
      body?: z.infer<InferBodySchema<(typeof v1Routes)[TName]>>;
      signal?: AbortSignal;
    } = {},
  ): Promise<z.infer<InferResponseSchema<(typeof v1Routes)[TName]>>> {
    const route = v1Routes[name];
    const { params, query, body, signal } = args;

    // Build path by replacing :param tokens if present
    const pathTemplate = route.path as string;
    let path: string = pathTemplate;

    // Validate params against schema when available
    const paramsSchema = (route as any)?.params as
      | z.ZodSchema<z.infer<InferParamsSchema<(typeof v1Routes)[TName]>>>
      | undefined;
    const validatedParams = paramsSchema
      ? (paramsSchema.parse(params) as z.infer<
          InferParamsSchema<(typeof v1Routes)[TName]>
        >)
      : (params as z.infer<InferParamsSchema<(typeof v1Routes)[TName]>>);

    if (validatedParams && typeof validatedParams === "object") {
      for (const [key, value] of Object.entries(validatedParams)) {
        path = path.replace(`:${key}`, encodeURIComponent(String(value)));
      }
    }

    // Validate query against schema when available
    const querySchema = (route as any)?.querystring as
      | z.ZodSchema<z.infer<InferQuerySchema<(typeof v1Routes)[TName]>>>
      | undefined;
    const validatedQuery = querySchema
      ? (querySchema.parse(query) as z.infer<
          InferQuerySchema<(typeof v1Routes)[TName]>
        >)
      : (query as z.infer<InferQuerySchema<(typeof v1Routes)[TName]>>);

    const url = buildUrl(baseUrl, path, validatedQuery as any);

    type TBody = z.infer<InferBodySchema<(typeof v1Routes)[TName]>>;
    type TRespSchema = InferResponseSchema<(typeof v1Routes)[TName]>;
    type TResp = z.infer<TRespSchema>;

    // Validate request body at runtime if a body schema exists
    const bodySchema = (route as any)?.schema?.body as
      | z.ZodSchema<TBody>
      | undefined;
    let validatedBody: TBody | undefined = undefined;
    if (bodySchema && body !== undefined) {
      validatedBody = bodySchema.parse(body);
    }

    const raw = await httpRequest<TBody, unknown>(route.method, url, {
      body: validatedBody as TBody,
      headers,
      signal,
    });

    // Find the appropriate response schema (try 200, then 204)
    const responseSchemas = (route as any).schema?.response;
    let responseSchema: z.ZodSchema<TResp> | undefined;

    // Try to find a response schema - prefer 200, fallback to 204
    if (responseSchemas) {
      responseSchema = responseSchemas[200] || responseSchemas[204];
    }

    // If we have a schema, validate the response
    if (responseSchema) {
      const parsed = responseSchema.parse(raw) as TResp;
      return parsed;
    }

    // If no schema found, return raw response
    return raw as TResp;
  }

  return { request } satisfies Client;
}

export type { IApiClientOptions } from "./http.js";
export { ApiError } from "./http.js";

export default { createClient };
