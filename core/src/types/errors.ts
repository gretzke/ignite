// Custom error types for Ignite

export class IgniteError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'IgniteError';
    this.code = code;
    this.details = details;
  }
}

export class ProfileError extends IgniteError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(message, code, details);
    this.name = 'ProfileError';
  }
}

export class FileSystemError extends IgniteError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(message, code, details);
    this.name = 'FileSystemError';
  }
}

export class PluginError extends IgniteError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(message, code, details);
    this.name = 'PluginError';
  }
}

// Error codes — the single registry. API reply helpers only accept members
// of this object, so a typo'd or unregistered code is a compile error.
export const ErrorCodes = {
  // Profile errors
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_ALREADY_EXISTS: 'PROFILE_ALREADY_EXISTS',
  INVALID_PROFILE_NAME: 'INVALID_PROFILE_NAME',
  CANNOT_DELETE_DEFAULT_PROFILE: 'CANNOT_DELETE_DEFAULT_PROFILE',
  CANNOT_DELETE_ACTIVE_PROFILE: 'CANNOT_DELETE_ACTIVE_PROFILE',
  CANNOT_DELETE_LAST_PROFILE: 'CANNOT_DELETE_LAST_PROFILE',
  PROFILE_LIST_ERROR: 'PROFILE_LIST_ERROR',
  PROFILE_ARCHIVE_LIST_ERROR: 'PROFILE_ARCHIVE_LIST_ERROR',
  PROFILE_GET_ERROR: 'PROFILE_GET_ERROR',
  PROFILE_CREATE_ERROR: 'PROFILE_CREATE_ERROR',
  PROFILE_SWITCH_ERROR: 'PROFILE_SWITCH_ERROR',
  PROFILE_UPDATE_ERROR: 'PROFILE_UPDATE_ERROR',
  PROFILE_ARCHIVE_ERROR: 'PROFILE_ARCHIVE_ERROR',
  PROFILE_RESTORE_ERROR: 'PROFILE_RESTORE_ERROR',
  PROFILE_DELETE_ERROR: 'PROFILE_DELETE_ERROR',
  PROFILE_REPOS_LIST_ERROR: 'PROFILE_REPOS_LIST_ERROR',
  PROFILE_REPO_SAVE_ERROR: 'PROFILE_REPO_SAVE_ERROR',
  PROFILE_REPO_DELETE_ERROR: 'PROFILE_REPO_DELETE_ERROR',
  REPO_ALREADY_EXISTS: 'REPO_ALREADY_EXISTS',

  // File system errors
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_JSON: 'INVALID_JSON',
  WRITE_FAILED: 'WRITE_FAILED',
  READ_FAILED: 'READ_FAILED',
  INVALID_PATH: 'INVALID_PATH',
  LIST_DIRECTORY_ERROR: 'LIST_DIRECTORY_ERROR',

  // Plugin registry/install errors
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_INSTALL_CONFLICT: 'PLUGIN_INSTALL_CONFLICT',
  PLUGIN_INSTALL_INVALID: 'PLUGIN_INSTALL_INVALID',
  PLUGIN_INSTALL_REJECTED: 'PLUGIN_INSTALL_REJECTED',
  PLUGIN_INSTALL_ERROR: 'PLUGIN_INSTALL_ERROR',
  PLUGIN_UNINSTALL_REJECTED: 'PLUGIN_UNINSTALL_REJECTED',
  PLUGIN_UNINSTALL_ERROR: 'PLUGIN_UNINSTALL_ERROR',
  PLUGIN_LIST_ERROR: 'PLUGIN_LIST_ERROR',
  PLUGIN_GET_ERROR: 'PLUGIN_GET_ERROR',

  // Execution / permission errors
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  OPERATION_EXECUTION_FAILED: 'OPERATION_EXECUTION_FAILED',

  // Job errors
  INTERRUPTED: 'INTERRUPTED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',

  // Trust / auth errors
  TRUST_LIST_ERROR: 'TRUST_LIST_ERROR',
  TRUST_UPDATE_ERROR: 'TRUST_UPDATE_ERROR',
  TRUST_IMMUTABLE: 'TRUST_IMMUTABLE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',

  // System
  SYSTEM_INFO_ERROR: 'SYSTEM_INFO_ERROR',

  // Compiler route errors
  NOT_A_COMPILER_PLUGIN: 'NOT_A_COMPILER_PLUGIN',
  NO_COMPILER_PLUGINS: 'NO_COMPILER_PLUGINS',
  UNKNOWN_PLUGIN: 'UNKNOWN_PLUGIN',
  INSTALL_FAILED: 'INSTALL_FAILED',
  COMPILE_FAILED: 'COMPILE_FAILED',
  ARTIFACT_LISTING_ERROR: 'ARTIFACT_LISTING_ERROR',
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  ARTIFACT_PARSE_ERROR: 'ARTIFACT_PARSE_ERROR',
  ARTIFACT_DATA_ERROR: 'ARTIFACT_DATA_ERROR',

  // Repo-manager route errors
  INIT_ERROR: 'INIT_ERROR',
  REPO_CHECK_ERROR: 'REPO_CHECK_ERROR',
  GET_BRANCHES_ERROR: 'GET_BRANCHES_ERROR',
  CHECKOUT_BRANCH_ERROR: 'CHECKOUT_BRANCH_ERROR',
  CHECKOUT_COMMIT_ERROR: 'CHECKOUT_COMMIT_ERROR',
  PULL_ERROR: 'PULL_ERROR',
  RESET_ERROR: 'RESET_ERROR',
  INFO_ERROR: 'INFO_ERROR',
  GET_FILE_ERROR: 'GET_FILE_ERROR',
  SUSPICIOUS_PATH_PATTERN: 'SUSPICIOUS_PATH_PATTERN',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
