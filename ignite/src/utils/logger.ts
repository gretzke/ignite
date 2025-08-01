// Global logger instance for Ignite

import type { Logger } from '../types/logger.js';

let globalLogger: Logger | null = null;

export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    // Fallback to console if no logger is set
    return {
      // eslint-disable-next-line no-console -- Fallback when no logger available
      info: console.log,
      // eslint-disable-next-line no-console -- Fallback when no logger available
      warn: console.warn,
      // eslint-disable-next-line no-console -- Fallback when no logger available
      error: console.error,
      // eslint-disable-next-line no-console -- Fallback when no logger available
      debug: console.debug,
    };
  }
  return globalLogger;
}

// Convenience functions
export function logInfo(message: string, ...args: unknown[]): void {
  getLogger().info(message, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  getLogger().warn(message, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  getLogger().error(message, ...args);
}

export function logDebug(message: string, ...args: unknown[]): void {
  getLogger().debug(message, ...args);
}
