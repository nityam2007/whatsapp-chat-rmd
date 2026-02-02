/**
 * Winston Logger with Loki Integration
 * 
 * Provides structured logging with:
 * - Console output for development
 * - File output for persistence
 * - Loki transport for centralized logging (when available)
 * - IST timezone support
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';

// Ensure logs directory exists
const LOGS_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Get IST timestamp for logs
 */
function getISTTimestamp(): string {
  return new Date().toLocaleString('sv-SE', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).replace(' ', 'T') + '+05:30';
}

// Custom IST timestamp format
const istFormat = winston.format((info) => {
  info.timestamp = getISTTimestamp();
  return info;
});

// JSON format for files and Loki
const logFormat = winston.format.combine(
  istFormat(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Pretty format for console in development
const consoleFormat = winston.format.combine(
  istFormat(),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length 
      ? '\n' + JSON.stringify(meta, null, 2) 
      : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Create transports array
const transports: winston.transport[] = [
  // Console output
  new winston.transports.Console({
    format: config.nodeEnv === 'development' ? consoleFormat : logFormat,
  }),
  
  // File output - all logs
  new winston.transports.File({
    filename: path.join(LOGS_DIR, 'rmd.log'),
    format: logFormat,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    tailable: true,
  }),
  
  // File output - errors only
  new winston.transports.File({
    filename: path.join(LOGS_DIR, 'error.log'),
    level: 'error',
    format: logFormat,
    maxsize: 10 * 1024 * 1024,
    maxFiles: 3,
    tailable: true,
  }),
];

// Add Loki transport if URL is configured
const lokiUrl = process.env.LOKI_URL;
if (lokiUrl) {
  // Dynamic import for winston-loki (optional dependency)
  import('winston-loki').then(({ default: LokiTransport }) => {
    const lokiTransport = new LokiTransport({
      host: lokiUrl,
      labels: { 
        app: 'rmd-service',
        environment: config.nodeEnv,
      },
      json: true,
      format: logFormat,
      replaceTimestamp: true,
      onConnectionError: (err: Error) => {
        console.error('Loki connection error:', err.message);
      },
    });
    logger.add(lokiTransport);
    logger.info('Loki transport connected', { url: lokiUrl });
  }).catch((err) => {
    console.warn('winston-loki not available, skipping Loki transport:', err.message);
  });
}

// Create the logger
export const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  transports,
  // Don't exit on unhandled exceptions
  exitOnError: false,
});

// Handle uncaught exceptions
logger.exceptions.handle(
  new winston.transports.File({ 
    filename: path.join(LOGS_DIR, 'exceptions.log'),
    format: logFormat,
  })
);

// Handle unhandled promise rejections
logger.rejections.handle(
  new winston.transports.File({ 
    filename: path.join(LOGS_DIR, 'rejections.log'),
    format: logFormat,
  })
);

// ============================================
// Structured logging helpers
// ============================================

export interface LogContext {
  messageId?: string;
  chatId?: string;
  sender?: string;
  eventId?: string;
  step?: string;
  duration?: number;
}

/**
 * Log with structured context
 */
export function logWithContext(level: string, message: string, context: LogContext, extra?: Record<string, unknown>): void {
  logger.log(level, message, { ...context, ...extra });
}

/**
 * Log pipeline step
 */
export function logPipelineStep(step: string, messageId: string, status: 'start' | 'success' | 'fail' | 'skip', details?: Record<string, unknown>): void {
  logger.info(`Pipeline: ${step}`, {
    step,
    messageId,
    status,
    ...details,
  });
}

/**
 * Log API request
 */
export function logApiRequest(method: string, path: string, statusCode: number, duration: number, extra?: Record<string, unknown>): void {
  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  logger.log(level, `API ${method} ${path}`, {
    type: 'api',
    method,
    path,
    statusCode,
    duration,
    ...extra,
  });
}

/**
 * Log AI call
 */
export function logAICall(model: string, operation: string, inputTokens: number, outputTokens: number, duration: number, success: boolean): void {
  logger.info(`AI ${operation}`, {
    type: 'ai',
    model,
    operation,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    duration,
    success,
  });
}

export default logger;
