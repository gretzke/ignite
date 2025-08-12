export interface IApiClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
}

export interface IRequestOptions {
  signal?: AbortSignal;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export function joinUrl(baseUrl: string | undefined, path: string): string {
  const base = baseUrl ?? "";
  if (!base) return path;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  if (base.endsWith("/") && path.startsWith("/"))
    return `${base.slice(0, -1)}${path}`;
  if (!base.endsWith("/") && !path.startsWith("/")) return `${base}/${path}`;
  return `${base}${path}`;
}

export function buildUrl(
  baseUrl: string | undefined,
  path: string,
  query?: Record<string, unknown> | URLSearchParams,
): string {
  const url = new URL(joinUrl(baseUrl, path), "http://placeholder");
  if (query) {
    const params =
      query instanceof URLSearchParams ? query : new URLSearchParams();
    if (!(query instanceof URLSearchParams)) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        params.set(key, String(value));
      });
    }
    url.search = params.toString();
  }
  return url.pathname + (url.search ? `?${url.searchParams.toString()}` : "");
}

export async function httpRequest<TBody, TResponse>(
  method: HttpMethod,
  fullUrl: string,
  options: {
    body?: TBody;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<TResponse> {
  const { body, headers, signal } = options;
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    signal,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(fullUrl, init);
  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const parsed = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error(
      typeof parsed === "string" ? parsed : parsed?.message ?? "Request failed",
    );
    // @ts-expect-error attach meta for callers if needed
    error.status = response.status;
    // @ts-expect-error attach body
    error.body = parsed;
    throw error;
  }

  return parsed as TResponse;
}
