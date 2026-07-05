import { describe, it, expect, vi } from 'vitest';
import { createJobsHandlers } from '../../api/jobs.js';
import type { JobRecord } from '@ignite/api';

function makeReply() {
  const reply = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return reply;
}

const job: JobRecord = {
  id: 'job-1',
  type: 'compiler.detect',
  params: {},
  state: 'running',
  createdAt: '2024-01-01T00:00:00.000Z',
  events: [],
};

function makeDeps(overrides?: Partial<ReturnType<typeof baseFakeJobs>>) {
  return { jobs: { ...baseFakeJobs(), ...overrides } };
}

function baseFakeJobs() {
  return {
    get: vi.fn((id: string) => (id === job.id ? job : undefined)),
    list: vi.fn((_filter?: { active?: boolean }) => [job]),
    cancel: vi.fn((_id: string) => true),
  };
}

describe('jobs handlers', () => {
  describe('getJob', () => {
    it('returns 404 JOB_NOT_FOUND when the job does not exist', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.getJob(
        { params: { jobId: 'missing' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(404);
      expect(reply.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        code: 'JOB_NOT_FOUND',
        message: expect.stringContaining('missing'),
      });
    });

    it('returns the job when found', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.getJob(
        { params: { jobId: 'job-1' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { job } });
    });
  });

  describe('listJobs', () => {
    it('lists all jobs when active is not set', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.listJobs({ query: {} } as never, reply as never);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toEqual({ data: { jobs: [job] } });
      expect(deps.jobs.list).toHaveBeenCalledWith(undefined);
    });

    it('filters to active jobs when active=true', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.listJobs(
        { query: { active: 'true' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(200);
      expect(deps.jobs.list).toHaveBeenCalledWith({ active: true });
    });

    it('does not filter when active=false', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.listJobs(
        { query: { active: 'false' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(200);
      expect(deps.jobs.list).toHaveBeenCalledWith(undefined);
    });
  });

  describe('cancelJob', () => {
    it('returns 404 JOB_NOT_FOUND when the job does not exist', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.cancelJob(
        { params: { jobId: 'missing' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(404);
      expect(reply.body).toEqual({
        statusCode: 404,
        error: 'Not Found',
        code: 'JOB_NOT_FOUND',
        message: expect.stringContaining('missing'),
      });
      expect(deps.jobs.cancel).not.toHaveBeenCalled();
    });

    it('returns 204 and calls cancel when the job is running', async () => {
      const deps = makeDeps();
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.cancelJob(
        { params: { jobId: 'job-1' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(204);
      expect(deps.jobs.cancel).toHaveBeenCalledWith('job-1');
    });

    it('returns 204 even when the job is already terminal (cancel() returns false)', async () => {
      const terminalJob: JobRecord = { ...job, state: 'succeeded' };
      const deps = makeDeps({
        get: vi.fn((id: string) =>
          id === terminalJob.id ? terminalJob : undefined
        ),
        cancel: vi.fn(() => false),
      });
      const handlers = createJobsHandlers(deps);
      const reply = makeReply();
      await handlers.cancelJob(
        { params: { jobId: 'job-1' } } as never,
        reply as never
      );
      expect(reply.statusCode).toBe(204);
      expect(deps.jobs.cancel).toHaveBeenCalledWith('job-1');
    });
  });
});
