// Jobs routes: persisted async job records (compiler detect/install/compile, plugin install)
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import { createApiResponseSchema } from "../utils/schema.js";

// Interface definitions first
export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type JobEventKind = "state" | "log";

export interface JobEvent {
  seq: number; // monotonic per job, starts at 1
  ts: string; // ISO timestamp
  kind: JobEventKind;
  // kind === 'state': data is the new JobState
  // kind === 'log':   data is one output line (or chunk) from the operation
  data: string;
}

export interface JobRecord {
  id: string; // crypto.randomUUID()
  type: string; // 'compiler.detect' | 'compiler.install' | 'compiler.compile' | 'plugin.install'
  params: Record<string, unknown>; // echo of request params (pathOrUrl, pluginId, source…)
  state: JobState;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: unknown; // runner return value on success (e.g. { frameworks } for detect)
  error?: { code: string; message: string; details?: unknown };
  events: JobEvent[]; // capped at MAX_EVENTS = 1000 (oldest dropped; seq keeps counting)
}

export interface JobStartedData {
  jobId: string;
}

export interface GetJobData {
  job: JobRecord;
}

export interface ListJobsData {
  jobs: JobRecord[];
}

export interface GetJobParams {
  jobId: string;
}

export interface ListJobsQuery {
  active?: "true" | "false";
}

export interface CancelJobParams {
  jobId: string;
}

// Zod schemas
export const JobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]) satisfies z.ZodType<JobState>;

export const JobEventSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  kind: z.enum(["state", "log"]),
  data: z.string(),
}) satisfies z.ZodType<JobEvent>;

export const JobRecordSchema = z.object({
  id: z.string(),
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
  state: JobStateSchema,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
  events: z.array(JobEventSchema),
}) satisfies z.ZodType<JobRecord>;

// Type-safe IApiResponse schemas that enforce interface compliance
export const JobStartedResponseSchema =
  createApiResponseSchema<JobStartedData>("JobStartedResponseSchema")(
    z.object({ jobId: z.string() }),
  );

export const GetJobResponseSchema = createApiResponseSchema<GetJobData>(
  "GetJobResponseSchema",
)(z.object({ job: JobRecordSchema }));

export const ListJobsResponseSchema = createApiResponseSchema<ListJobsData>(
  "ListJobsResponseSchema",
)(z.object({ jobs: z.array(JobRecordSchema) }));

export const GetJobParamsSchema = z.object({
  jobId: z.string(),
});
export type GetJobParamsType = z.infer<typeof GetJobParamsSchema>;

export const ListJobsQuerySchema = z.object({
  active: z.enum(["true", "false"]).optional(),
});
export type ListJobsQueryType = z.infer<typeof ListJobsQuerySchema>;

export const CancelJobParamsSchema = z.object({
  jobId: z.string(),
});
export type CancelJobParamsType = z.infer<typeof CancelJobParamsSchema>;

// Route definitions
export const jobsRoutes = {
  getJob: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/jobs/:jobId`,
    params: GetJobParamsSchema,
    schema: {
      tags: ["jobs"],
      response: {
        200: GetJobResponseSchema,
      },
    },
  },
  listJobs: {
    method: "GET" as const,
    path: `${V1_BASE_PATH}/jobs`,
    querystring: ListJobsQuerySchema,
    schema: {
      tags: ["jobs"],
      response: {
        200: ListJobsResponseSchema,
      },
    },
  },
  cancelJob: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/jobs/:jobId/cancel`,
    params: CancelJobParamsSchema,
    schema: {
      tags: ["jobs"],
      response: {
        204: z.null(),
      },
    },
  },
} as const;
