/**
 * Main Entry Point
 * 
 * WhatsApp Chat RMD - AI-powered event extraction
 * 
 * AUTO-LEARNING SYSTEM:
 * This system learns from LLM extractions to create better rule patterns.
 * Over time, more messages are handled by the rule engine (fast, free)
 * instead of the LLM (slow, expensive).
 */

import { initDatabase, closeDatabase } from './database/sqlite.js';
import { initVectorStore } from './vector/faiss.js';
import { initScheduler, cleanupReminders } from './scheduler/index.js';
import { startServer } from './server.js';
import { validateConfig } from './config/index.js';
import logger from './utils/logger.js';
import { metrics } from './utils/metrics.js';
import { 
  initPatternLearningTables, 
  logLLMExtraction, 
  getCompiledLearnedPatterns,
  runPatternLearning,
  updatePatternStats,
} from './pipeline/patternLearner.js';
import { 
  loadLearnedPatterns, 
  needsPatternReload,
  setPatternStatsCallback,
} from './pipeline/ruleEngine.js';
import { setExtractionLogCallback } from './pipeline/extractor.js';
import Database from 'better-sqlite3';

// Metrics logging interval (default: 5 minutes)
const METRICS_LOG_INTERVAL = parseInt(process.env.METRICS_LOG_INTERVAL || '300000', 10);
// Pattern learning interval (default: 1 hour)
const PATTERN_LEARNING_INTERVAL = parseInt(process.env.PATTERN_LEARNING_INTERVAL || '3600000', 10);

let metricsInterval: NodeJS.Timeout | null = null;
let patternLearningInterval: NodeJS.Timeout | null = null;
let patternReloadInterval: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  logger.info('Starting WhatsApp Chat RMD...');

  // Validate configuration
  const configErrors = validateConfig();
  if (configErrors.length > 0) {
    logger.warn('Configuration warnings:', { errors: configErrors });
    // Continue anyway - will use fallback implementations
  }

  // Initialize database
  let db: Database.Database;
  try {
    db = initDatabase();
    logger.info('Database initialized');
  } catch (error) {
    logger.error('Failed to initialize database', { error });
    process.exit(1);
  }

  // Initialize pattern learning tables
  try {
    initPatternLearningTables(db);
    logger.info('Pattern learning tables initialized');
    
    // Load learned patterns into rule engine
    reloadLearnedPatterns();
    
    // Set up callbacks for auto-learning
    setupPatternLearningCallbacks();
    
  } catch (error) {
    logger.error('Failed to initialize pattern learning', { error });
    // Non-fatal - continue without pattern learning
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

  // Start periodic pattern learning (if interval > 0)
  if (PATTERN_LEARNING_INTERVAL > 0) {
    patternLearningInterval = setInterval(async () => {
      try {
        logger.info('Running scheduled pattern learning...');
        const result = await runPatternLearning();
        logger.info('Pattern learning completed', result);
        
        // Reload patterns after learning
        if (result.patternsAdded > 0) {
          reloadLearnedPatterns();
        }
      } catch (error) {
        logger.error('Scheduled pattern learning failed', { error });
      }
    }, PATTERN_LEARNING_INTERVAL);
    
    logger.info('Periodic pattern learning enabled', {
      intervalMs: PATTERN_LEARNING_INTERVAL,
      intervalHours: Math.round(PATTERN_LEARNING_INTERVAL / 3600000),
    });
  }

  // Start pattern reload checker (every 5 minutes)
  patternReloadInterval = setInterval(() => {
    if (needsPatternReload()) {
      reloadLearnedPatterns();
    }
  }, 5 * 60 * 1000);

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/**
 * Reload learned patterns into the rule engine
 */
function reloadLearnedPatterns(): void {
  try {
    const patterns = getCompiledLearnedPatterns();
    loadLearnedPatterns(patterns);
  } catch (error) {
    logger.warn('Failed to reload learned patterns', { error });
  }
}

/**
 * Set up callbacks for the auto-learning feedback loop
 */
function setupPatternLearningCallbacks(): void {
  // Callback for logging LLM extractions
  setExtractionLogCallback((data) => {
    try {
      logLLMExtraction(data);
    } catch (error) {
      logger.warn('Failed to log LLM extraction', { error });
    }
  });
  
  // Callback for updating pattern stats (hit/miss)
  setPatternStatsCallback((patternId, hit) => {
    try {
      updatePatternStats(patternId, hit);
    } catch (error) {
      logger.warn('Failed to update pattern stats', { error });
    }
  });
  
  logger.info('Pattern learning callbacks configured');
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
  
  // Stop pattern learning
  if (patternLearningInterval) {
    clearInterval(patternLearningInterval);
    patternLearningInterval = null;
  }
  
  // Stop pattern reload checker
  if (patternReloadInterval) {
    clearInterval(patternReloadInterval);
    patternReloadInterval = null;
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
