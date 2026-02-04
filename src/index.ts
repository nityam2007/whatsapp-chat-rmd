/**
 * Main Entry Point
 * 
 * Argus - AI-powered event extraction from WhatsApp messages
 * 
 * Simplified archv2 pipeline with FAISS-backed semantic search.
 */

import { initDatabase, closeDatabase } from './database/sqlite.js';
import { initVectorStore } from './vector/faiss.js';
import { initScheduler, cleanupReminders } from './scheduler/index.js';
import { startServer } from './server.js';
import { validateConfig } from './config/index.js';
import logger from './utils/logger.js';
import { metrics } from './utils/metrics.js';

// Metrics logging interval (default: 5 minutes)
const METRICS_LOG_INTERVAL = parseInt(process.env.METRICS_LOG_INTERVAL || '300000', 10);
let metricsInterval: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  logger.info('Starting Argus...');

  // Validate configuration
  const configErrors = validateConfig();
  if (configErrors.length > 0) {
    logger.warn('Configuration warnings:', { errors: configErrors });
    // Continue anyway - will use fallback implementations
  }

  // Initialize database
  try {
    initDatabase();
    logger.info('Database initialized');
  } catch (error) {
    logger.error('Failed to initialize database', { error });
    process.exit(1);
  }

  // Initialize vector store
  try {
    initVectorStore();
    logger.info('Vector store initialized');
  } catch (error) {
    logger.error('Failed to initialize vector store', { error });
    process.exit(1);
  }

  // Initialize scheduler (loads pending reminders from DB)
  try {
    await initScheduler();
    logger.info('Scheduler initialized');
  } catch (error) {
    logger.error('Failed to initialize scheduler', { error });
    // Non-fatal - continue without scheduler
  }

  // Start server
  startServer();

  // Start periodic metrics logging (if interval > 0)
  if (METRICS_LOG_INTERVAL > 0) {
    metricsInterval = setInterval(() => {
      metrics.logSummary();
    }, METRICS_LOG_INTERVAL);
    
    logger.info('Periodic metrics logging enabled', { 
      intervalMs: METRICS_LOG_INTERVAL,
      intervalMinutes: Math.round(METRICS_LOG_INTERVAL / 60000),
    });
  }

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down...');
  
  // Stop metrics logging
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
    // Log final metrics summary
    logger.info('Final metrics before shutdown');
    metrics.logSummary();
  }
  
  // Cleanup reminders
  cleanupReminders();
  
  // Close database
  closeDatabase();
  
  logger.info('Shutdown complete');
  process.exit(0);
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error });
  process.exit(1);
});

// Run
main().catch((error) => {
  logger.error('Fatal error', { error });
  process.exit(1);
});
