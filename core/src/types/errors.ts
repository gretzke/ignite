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

// Error codes
export const ErrorCodes = {
  // Profile errors
  PROFILE_NOT_FOUND: 'PROFILE_NOT_FOUND',
  PROFILE_ALREADY_EXISTS: 'PROFILE_ALREADY_EXISTS',
  INVALID_PROFILE_NAME: 'INVALID_PROFILE_NAME',
  CANNOT_DELETE_DEFAULT_PROFILE: 'CANNOT_DELETE_DEFAULT_PROFILE',
  CANNOT_DELETE_ACTIVE_PROFILE: 'CANNOT_DELETE_ACTIVE_PROFILE',

  // File system errors
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_JSON: 'INVALID_JSON',
  WRITE_FAILED: 'WRITE_FAILED',
  READ_FAILED: 'READ_FAILED',

  // Plugin errors
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
} as const;
