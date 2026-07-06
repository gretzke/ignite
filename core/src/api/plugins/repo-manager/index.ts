// Repo-manager route handlers — thin wrappers over RepoService (host git).
// `init` is the one job-backed op (cloning is slow/network-bound); every
// other op is fast on host disk and stays synchronous.
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PathOptions } from '@ignite/plugin-types';
import type {
  IApiResponse,
  JobStartedData,
  CheckoutBranchRequest,
  CheckoutCommitRequest,
  GetFileRequest,
  RepoGetBranchesResult,
  RepoInfoResult,
  RepoGetFileResult,
} from '@ignite/api';
import type { z } from 'zod';
import {
  RepoService,
  RepoKind,
  deriveRepoKind,
  isAllowedCloneUrl,
  type RepoResult,
} from '../../../repos/RepoService.js';
import { JobManager } from '../../../jobs/JobManager.js';
import { ErrorCodes, type ErrorCode } from '../../../types/errors.js';
import { sendPluginError, sendBadRequest } from '../../utils/errors.js';

// Subsets of the real singletons the handlers depend on — narrow enough that
// tests can inject fakes without implementing the full classes.
export interface RepoServiceLike {
  init: RepoService['init'];
  getBranches: RepoService['getBranches'];
  checkoutBranch: RepoService['checkoutBranch'];
  checkoutCommit: RepoService['checkoutCommit'];
  pullChanges: RepoService['pullChanges'];
  reset: RepoService['reset'];
  getRepoInfo: RepoService['getRepoInfo'];
  getFile: RepoService['getFile'];
}

export interface RepoJobManagerLike {
  start: JobManager['start'];
}

export interface RepoHandlerDeps {
  repos: RepoServiceLike;
  jobs: RepoJobManagerLike;
}

// Every non-init op stays a flat 500 on failure, matching the old
// plugin-executor handlers exactly — only getFile (below) has a richer
// status-code mapping.
function sendRepoError<T>(
  reply: FastifyReply,
  result: RepoResult<T>,
  fallbackCode: ErrorCode,
  fallbackMessage: string,
  statusCode: 404 | 500 = 500
) {
  return sendPluginError(
    reply,
    result,
    fallbackCode,
    fallbackMessage,
    statusCode
  );
}

export function createRepoHandlers(deps?: Partial<RepoHandlerDeps>) {
  const d: RepoHandlerDeps = {
    repos: deps?.repos ?? RepoService.getInstance(),
    jobs: deps?.jobs ?? JobManager.getInstance(),
  };

  return {
    init: async (
      request: FastifyRequest<{ Body: PathOptions }>,
      reply: FastifyReply
    ): Promise<IApiResponse<JobStartedData>> => {
      const { pathOrUrl } = request.body;

      // Sync pre-flight: reject an unclonable URL scheme before a job is
      // ever created (ext:: / fd:: and friends can execute arbitrary host
      // commands or inherit arbitrary fds — never worth a round trip through
      // the job machinery).
      if (
        deriveRepoKind(pathOrUrl) === RepoKind.CLONED &&
        !isAllowedCloneUrl(pathOrUrl)
      ) {
        sendBadRequest(
          reply,
          ErrorCodes.INIT_ERROR,
          `Refusing to clone repository: unsupported URL scheme in '${pathOrUrl}'. ` +
            'Only https://, git://, ssh://, file://, and git@host:path are allowed.'
        );
        return reply as unknown as IApiResponse<JobStartedData>;
      }

      const job = d.jobs.start(
        'repo.init',
        { pathOrUrl },
        async (ctx): Promise<null> => {
          ctx.log(`Initializing repository ${pathOrUrl}...`);
          const result = await d.repos.init(pathOrUrl);
          if (!result.success) {
            throw Object.assign(new Error(result.error.message), {
              code: result.error.code,
            });
          }
          ctx.log(`Repository ${pathOrUrl} initialized.`);
          return null;
        }
      );

      return reply.status(200).send({ data: { jobId: job.id } });
    },

    getBranches: async (
      request: FastifyRequest<{ Body: PathOptions }>,
      reply: FastifyReply
    ): Promise<IApiResponse<RepoGetBranchesResult>> => {
      const result = await d.repos.getBranches(request.body.pathOrUrl);
      if (!result.success) {
        return sendRepoError(
          reply,
          result,
          ErrorCodes.GET_BRANCHES_ERROR,
          'Failed to get branches'
        );
      }
      return reply.status(200).send({ data: result.data });
    },

    checkoutBranch: async (
      request: FastifyRequest<{
        Body: CheckoutBranchRequest;
      }>,
      reply: FastifyReply
    ): Promise<z.ZodNull> => {
      const { pathOrUrl, branch } = request.body;
      const result = await d.repos.checkoutBranch(pathOrUrl, branch);
      if (!result.success) {
        return sendRepoError(
          reply,
          result,
          ErrorCodes.CHECKOUT_BRANCH_ERROR,
          'Failed to checkout branch'
        );
      }
      return reply.status(204).send(null);
    },

    checkoutCommit: async (
      request: FastifyRequest<{
        Body: CheckoutCommitRequest;
      }>,
      reply: FastifyReply
    ): Promise<z.ZodNull> => {
      const { pathOrUrl, commit } = request.body;
      const result = await d.repos.checkoutCommit(pathOrUrl, commit);
      if (!result.success) {
        return sendRepoError(
          reply,
          result,
          ErrorCodes.CHECKOUT_COMMIT_ERROR,
          'Failed to checkout commit'
        );
      }
      return reply.status(204).send(null);
    },

    pullChanges: async (
      request: FastifyRequest<{ Body: PathOptions }>,
      reply: FastifyReply
    ): Promise<z.ZodNull> => {
      const result = await d.repos.pullChanges(request.body.pathOrUrl);
      if (!result.success) {
        return sendRepoError(
          reply,
          result,
          ErrorCodes.PULL_ERROR,
          'Failed to pull changes'
        );
      }
      return reply.status(204).send(null);
    },

    resetRepo: async (
      request: FastifyRequest<{ Body: PathOptions }>,
      reply: FastifyReply
    ): Promise<z.ZodNull> => {
      const result = await d.repos.reset(request.body.pathOrUrl);
      if (!result.success) {
        return sendRepoError(
          reply,
          result,
          ErrorCodes.RESET_ERROR,
          'Failed to reset repository'
        );
      }
      return reply.status(204).send(null);
    },

    getRepoInfo: async (
      request: FastifyRequest<{ Body: PathOptions }>,
      reply: FastifyReply
    ): Promise<IApiResponse<RepoInfoResult>> => {
      const result = await d.repos.getRepoInfo(request.body.pathOrUrl);
      if (!result.success) {
        return sendRepoError(
          reply,
          result,
          ErrorCodes.INFO_ERROR,
          'Failed to get repo info'
        );
      }
      return reply.status(200).send({ data: result.data });
    },

    getFile: async (
      request: FastifyRequest<{ Body: GetFileRequest }>,
      reply: FastifyReply
    ): Promise<IApiResponse<RepoGetFileResult>> => {
      const { pathOrUrl, filePath } = request.body;
      const result = await d.repos.getFile(pathOrUrl, filePath);
      if (!result.success) {
        // Map specific error codes to appropriate HTTP status codes, exactly
        // matching the old plugin-executor handler.
        let statusCode: 404 | 403 | 500 = 500;
        if (result.error.code === 'FILE_NOT_FOUND') {
          statusCode = 404;
        } else if (
          result.error.code === 'INVALID_PATH' ||
          result.error.code === 'SUSPICIOUS_PATH_PATTERN'
        ) {
          statusCode = 403;
        }
        if (statusCode === 403) {
          return reply.status(403).send({
            statusCode: 403,
            error: 'Forbidden',
            code: result.error.code,
            message: result.error.message,
          });
        }
        return sendRepoError(
          reply,
          result,
          ErrorCodes.GET_FILE_ERROR,
          'Failed to get file',
          statusCode
        );
      }
      return reply.status(200).send({ data: result.data });
    },
  };
}

// Production wiring: same exported name as before, so route registration in
// core/src/api/index.ts is untouched.
export const repoManagerHandlers = createRepoHandlers();
