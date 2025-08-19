// Global logger instance for Ignite

import fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from '../types/logger.js';

// Enhanced logger interface that accepts multiple arguments
interface EnhancedLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export function setGlobalLogger(logger: Logger): void {
  LoggerManager.setGlobalLogger(logger);
}

export function getLogger(): EnhancedLogger {
  return LoggerManager.getLogger();
}

class LoggerManager {
  private static instance: LoggerManager;
  private logger: Logger;
  private enhancedLogger: EnhancedLogger;

  private constructor() {
    // Fallback if no logger is set
    const bootstrapLoggerApp: FastifyInstance = fastify({
      logger: process.env.NODE_ENV === 'development',
    });
    this.logger = bootstrapLoggerApp.log;
    this.enhancedLogger = this.createEnhancedLogger();
  }

  private createEnhancedLogger(): EnhancedLogger {
    const formatMessage = (...args: unknown[]): string => {
      return args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ');
    };

    return {
      info: (...args: unknown[]) => {
        this.logger.info(formatMessage(...args));
      },
      warn: (...args: unknown[]) => {
        this.logger.warn(formatMessage(...args));
      },
      error: (...args: unknown[]) => {
        this.logger.error(formatMessage(...args));
      },
      debug: (...args: unknown[]) => {
        this.logger.debug(formatMessage(...args));
      },
    };
  }

  static getLogger(): EnhancedLogger {
    if (!LoggerManager.instance) {
      LoggerManager.instance = new LoggerManager();
    }
    return LoggerManager.instance.enhancedLogger;
  }

  static setGlobalLogger(logger: Logger) {
    if (!LoggerManager.instance) {
      LoggerManager.instance = new LoggerManager();
    }
    LoggerManager.instance.logger = logger;
    // Recreate enhanced logger with new underlying logger
    LoggerManager.instance.enhancedLogger =
      LoggerManager.instance.createEnhancedLogger();
  }
}
