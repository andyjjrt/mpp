import pino from 'pino';

import type { LogLevel } from '../types.js';

const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

function resolveInitialLogLevel(): LogLevel {
  const rawValue = process.env.LOG_LEVEL;

  if (rawValue !== undefined && VALID_LOG_LEVELS.includes(rawValue as LogLevel)) {
    return rawValue as LogLevel;
  }

  return DEFAULT_LOG_LEVEL;
}

const rootLogger = pino({
  level: resolveInitialLogLevel(),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    bindings: () => ({}),
    level: (label) => ({ level: label }),
  },
});

export type AppLogger = typeof rootLogger;

export function createLogger(bindings?: pino.Bindings): AppLogger {
  return bindings === undefined ? rootLogger : rootLogger.child(bindings);
}

export function setLoggerLevel(level: LogLevel): void {
  rootLogger.level = level;
}
