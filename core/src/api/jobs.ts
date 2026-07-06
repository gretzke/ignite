// Jobs route handlers — thin HTTP↔domain translation only.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  IApiResponse,
  IApiError,
  GetJobData,
  ListJobsData,
  GetJobParams,
  ListJobsQuery,
  CancelJobParams,
} from '@ignite/api';
import { JobManager } from '../jobs/JobManager.js';
import { ErrorCodes } from '../types/errors.js';

// The subset of JobManager the handlers use (tests pass fakes).
export interface JobManagerLike {
  get: JobManager['get'];
  list: JobManager['list'];
  cancel: JobManager['cancel'];
}

export interface JobsHandlerDeps {
  jobs: JobManagerLike;
}

function jobNotFound(jobId: string): IApiError {
  return {
    statusCode: 404,
    error: 'Not Found',
    code: ErrorCodes.JOB_NOT_FOUND,
    message: `Job ${jobId} not found`,
  };
}

export function createJobsHandlers(deps?: Partial<JobsHandlerDeps>) {
  const d: JobsHandlerDeps = {
    jobs: deps?.jobs ?? JobManager.getInstance(),
  };

  return {
    getJob: async (
      request: FastifyRequest<{ Params: GetJobParams }>,
      reply: FastifyReply
    ): Promise<IApiResponse<GetJobData>> => {
      const { jobId } = request.params;
      const job = d.jobs.get(jobId);
      if (!job) {
        return reply.status(404).send(jobNotFound(jobId));
      }
      return reply.status(200).send({ data: { job } });
    },

    listJobs: async (
      request: FastifyRequest<{ Querystring: ListJobsQuery }>,
      reply: FastifyReply
    ): Promise<IApiResponse<ListJobsData>> => {
      const { active } = request.query;
      // Both documented values filter; only an absent param means "all jobs".
      const filter =
        active === 'true'
          ? { active: true }
          : active === 'false'
            ? { active: false }
            : undefined;
      const jobs = d.jobs.list(filter);
      return reply.status(200).send({ data: { jobs } });
    },

    cancelJob: async (
      request: FastifyRequest<{ Params: CancelJobParams }>,
      reply: FastifyReply
    ): Promise<null> => {
      const { jobId } = request.params;
      const job = d.jobs.get(jobId);
      if (!job) {
        return reply.status(404).send(jobNotFound(jobId)) as unknown as null;
      }
      // Idempotent: cancel() returns false when the job is already terminal,
      // but the route still reports success since the desired end state
      // (job not running) already holds.
      d.jobs.cancel(jobId);
      return reply.status(204).send(null);
    },
  };
}

// Production wiring — same exported name as before, so route registration in
// core/src/api/index.ts is untouched.
export const jobsHandlers = createJobsHandlers();
