import { describe, it, expect } from 'vitest';
import {
  sendCaughtError,
  sendBadRequest,
  sendPluginError,
} from '../../api/utils/errors.js';
import { ErrorCodes } from '../../types/errors.js';

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

describe('api error helpers', () => {
  it('registers every legacy handler code in ErrorCodes', () => {
    // Codes currently written as raw string literals across core/src.
    // After this task they must all exist in the registry.
    const legacy = [
      'PROFILE_LIST_ERROR',
      'PROFILE_ARCHIVE_LIST_ERROR',
      'PROFILE_GET_ERROR',
      'PROFILE_CREATE_ERROR',
      'PROFILE_SWITCH_ERROR',
      'PROFILE_UPDATE_ERROR',
      'PROFILE_ARCHIVE_ERROR',
      'PROFILE_RESTORE_ERROR',
      'PROFILE_DELETE_ERROR',
      'PROFILE_REPOS_LIST_ERROR',
      'PROFILE_REPO_SAVE_ERROR',
      'PROFILE_REPO_DELETE_ERROR',
      'PLUGIN_LIST_ERROR',
      'PLUGIN_GET_ERROR',
      'SYSTEM_INFO_ERROR',
      'LIST_DIRECTORY_ERROR',
      'INVALID_PATH',
      'PERMISSION_REQUIRED',
      'OPERATION_EXECUTION_FAILED',
      'TRUST_LIST_ERROR',
      'TRUST_UPDATE_ERROR',
      'TRUST_IMMUTABLE',
      'UNAUTHORIZED',
      'HOST_NOT_ALLOWED',
      'PLUGIN_INSTALL_REJECTED',
      'PLUGIN_INSTALL_ERROR',
      'PLUGIN_UNINSTALL_REJECTED',
      'PLUGIN_UNINSTALL_ERROR',
    ];
    for (const code of legacy) {
      expect(Object.values(ErrorCodes)).toContain(code);
    }
  });

  it('sendCaughtError builds the exact legacy 500 body', () => {
    const reply = makeReply();
    sendCaughtError(
      reply as never,
      new Error('boom'),
      ErrorCodes.PROFILE_LIST_ERROR,
      'Failed to list profiles'
    );
    expect(reply.statusCode).toBe(500);
    expect(reply.body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'PROFILE_LIST_ERROR',
      message: 'Failed to list profiles',
      details: { error: 'boom' },
    });
  });

  it('sendBadRequest builds a 400 body', () => {
    const reply = makeReply();
    sendBadRequest(reply as never, ErrorCodes.INVALID_PATH, 'bad path');
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      code: 'INVALID_PATH',
      message: 'bad path',
    });
  });

  it('sendPluginError prefers the plugin error code over the fallback', () => {
    const reply = makeReply();
    sendPluginError(
      reply as never,
      {
        success: false,
        error: { code: 'COMPILE_FAILED', message: 'nope' },
      },
      ErrorCodes.COMPILE_ERROR,
      'Compilation failed'
    );
    expect(reply.statusCode).toBe(500);
    expect((reply.body as { code: string }).code).toBe('COMPILE_FAILED');
  });
});
