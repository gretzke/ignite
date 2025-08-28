import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  RepoCheckoutBranchOptions,
  RepoCheckoutCommitOptions,
  RepoGetBranchesResult,
  RepoInfoResult,
  RepoGetFileOptions,
  RepoGetFileResult,
} from '@ignite/plugin-types/base/repo-manager';
import type { PathOptions } from '@ignite/plugin-types';
import type { IApiError, IApiResponse } from '@ignite/api';
import { z } from 'zod';
import { PluginOrchestrator } from '../../../plugins/containers/PluginOrchestrator.js';
import {
  RepoContainerUtils,
  RepoContainerKind,
} from '../../../plugins/utils/RepoContainerUtils.js';

// Helper function to determine correct repo plugin based on path
function getRepoPluginId(pathOrUrl: string): string {
  const repoKind = RepoContainerUtils.deriveRepoKind(pathOrUrl);
  return repoKind === RepoContainerKind.LOCAL ? 'local-repo' : 'cloned-repo';
}

export const repoManagerHandlers = {
  init: async (
    request: FastifyRequest<{ Body: PathOptions }>,
    reply: FastifyReply
  ): Promise<z.ZodNull> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(pluginId, 'init', {
      pathOrUrl: request.body.pathOrUrl,
    });
    if (!result.success) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: result.error?.code || 'INIT_ERROR',
        message: result.error?.message || 'Failed to init repository',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    return reply.status(204).send(null);
  },

  getBranches: async (
    request: FastifyRequest<{ Body: PathOptions }>,
    reply: FastifyReply
  ): Promise<IApiResponse<RepoGetBranchesResult>> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(pluginId, 'getBranches', {
      pathOrUrl: request.body.pathOrUrl,
    });
    if (!result.success) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: result.error?.code || 'GET_BRANCHES_ERROR',
        message: result.error?.message || 'Failed to get branches',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    const body: IApiResponse<RepoGetBranchesResult> = {
      data: result.data as RepoGetBranchesResult,
    };
    return reply.status(200).send(body);
  },

  checkoutBranch: async (
    request: FastifyRequest<{ Body: PathOptions & RepoCheckoutBranchOptions }>,
    reply: FastifyReply
  ): Promise<z.ZodNull> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(
      pluginId,
      'checkoutBranch',
      {
        pathOrUrl: request.body.pathOrUrl,
        branch: request.body.branch,
      }
    );
    if (!result.success) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: result.error?.code || 'CHECKOUT_BRANCH_ERROR',
        message: result.error?.message || 'Failed to checkout branch',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    return reply.status(204).send(null);
  },

  checkoutCommit: async (
    request: FastifyRequest<{ Body: PathOptions & RepoCheckoutCommitOptions }>,
    reply: FastifyReply
  ): Promise<z.ZodNull> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(
      pluginId,
      'checkoutCommit',
      {
        pathOrUrl: request.body.pathOrUrl,
        commit: request.body.commit,
      }
    );
    if (!result.success) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: result.error?.code || 'CHECKOUT_COMMIT_ERROR',
        message: result.error?.message || 'Failed to checkout commit',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    return reply.status(204).send(null);
  },

  pullChanges: async (
    request: FastifyRequest<{ Body: PathOptions }>,
    reply: FastifyReply
  ): Promise<z.ZodNull> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(pluginId, 'pullChanges', {
      pathOrUrl: request.body.pathOrUrl,
    });
    if (!result.success) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: result.error?.code || 'PULL_ERROR',
        message: result.error?.message || 'Failed to pull changes',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    return reply.status(204).send(null);
  },

  getRepoInfo: async (
    request: FastifyRequest<{ Body: PathOptions }>,
    reply: FastifyReply
  ): Promise<IApiResponse<RepoInfoResult>> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(pluginId, 'getRepoInfo', {
      pathOrUrl: request.body.pathOrUrl,
    });
    if (!result.success) {
      const statusCode = 500 as const;
      const body: IApiError = {
        statusCode,
        error: 'Internal Server Error',
        code: result.error?.code || 'INFO_ERROR',
        message: result.error?.message || 'Failed to get repo info',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    const body: IApiResponse<RepoInfoResult> = {
      data: result.data as RepoInfoResult,
    };
    return reply.status(200).send(body);
  },

  getFile: async (
    request: FastifyRequest<{ Body: PathOptions & RepoGetFileOptions }>,
    reply: FastifyReply
  ): Promise<IApiResponse<RepoGetFileResult>> => {
    const orchestrator = PluginOrchestrator.getInstance();
    const pluginId = getRepoPluginId(request.body.pathOrUrl);
    const result = await orchestrator.executePlugin(pluginId, 'getFile', {
      pathOrUrl: request.body.pathOrUrl,
      filePath: request.body.filePath,
    });
    if (!result.success) {
      // Map specific error codes to appropriate HTTP status codes
      let statusCode: 404 | 403 | 500 = 500;
      if (result.error?.code === 'FILE_NOT_FOUND') {
        statusCode = 404;
      } else if (
        result.error?.code === 'INVALID_PATH' ||
        result.error?.code === 'SUSPICIOUS_PATH_PATTERN'
      ) {
        statusCode = 403; // Forbidden
      }

      const body: IApiError = {
        statusCode,
        error:
          statusCode === 404
            ? 'Not Found'
            : statusCode === 403
              ? 'Forbidden'
              : 'Internal Server Error',
        code: result.error?.code || 'GET_FILE_ERROR',
        message: result.error?.message || 'Failed to get file',
        details: result.error?.details,
      };
      return reply.status(statusCode).send(body);
    }
    const body: IApiResponse<RepoGetFileResult> = {
      data: result.data as RepoGetFileResult,
    };
    return reply.status(200).send(body);
  },
} as const;
