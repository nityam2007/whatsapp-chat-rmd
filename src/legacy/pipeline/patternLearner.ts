/**
 * Pattern Learner Service
 * 
 * Autonomous system that learns from LLM extractions to create new rule patterns.
 * 
 * How it works:
 * 1. LLM extractions are logged to llm_extraction_logs table
 * 2. PatternLearner analyzes logs periodically
 * 3. Finds common patterns in successful extractions
 * 4. Generates regex patterns that could have extracted the same data
 * 5. Validates patterns against historical data
 * 6. Stores validated patterns in learned_patterns table
 * 7. Rule Engine loads these patterns at startup and uses them
 * 
 * This creates a feedback loop:
 * More LLM extractions → Better patterns → Less LLM usage → Cost savings
 */

import Database from 'better-sqlite3';
import logger from '../../utils/logger.js';
import { getISTTimestamp } from '../../database/sqlite.js';

// ==========================================
// TYPES
// ==========================================

export interface LLMExtractionLog {
  id: string;
  message_id: string;
  raw_message: string;
  normalized_message: string;
  event_type: string;
  extracted_title: string | null;
  extracted_time: string | null;
  extracted_date: string | null;
  extracted_participants: string | null;
  llm_model: string;
  llm_tokens_used: number;
  llm_latency_ms: number;
  confidence: number;
  created_at: string;
}

export interface LearnedPattern {
  id: string;
  pattern_type: 'time' | 'date' | 'action' | 'participant';
  regex_pattern: string;
  capture_groups: string;  // JSON: { group_name: description }
  examples: string;        // JSON array of matching examples
  hit_count: number;
  miss_count: number;
  accuracy: number;
  is_active: boolean;
  created_from_logs: string;  // JSON array of log IDs used to create this
  created_at: string;
  last_validated_at: string;
}

export interface PatternCandidate {
  pattern: string;
  type: 'time' | 'date' | 'action' | 'participant';
  examples: string[];
  frequency: number;
}

// ==========================================
// DATABASE SETUP
// ==========================================

let dbInstance: Database.Database | null = null;

/**
 * Initialize pattern learning tables
 */
export function initPatternLearningTables(db: Database.Database): void {
  dbInstance = db;
  
  // Table for logging LLM extractions
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_extraction_logs (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      raw_message TEXT NOT NULL,
      normalized_message TEXT NOT NULL,
      event_type TEXT,
      extracted_title TEXT,
      extracted_time TEXT,
      extracted_date TEXT,
      extracted_participants TEXT,
      llm_model TEXT,
      llm_tokens_used INTEGER DEFAULT 0,
      llm_latency_ms INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      rule_engine_tried INTEGER DEFAULT 0,
      rule_engine_confidence REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_llm_logs_message_id ON llm_extraction_logs(message_id);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_event_type ON llm_extraction_logs(event_type);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_created_at ON llm_extraction_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_confidence ON llm_extraction_logs(confidence);
  `);

  // Table for learned patterns
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id TEXT PRIMARY KEY,
      pattern_type TEXT NOT NULL,
      regex_pattern TEXT NOT NULL UNIQUE,
      capture_groups TEXT,
      examples TEXT,
      hit_count INTEGER DEFAULT 0,
      miss_count INTEGER DEFAULT 0,
      accuracy REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 50,
      created_from_logs TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_validated_at TEXT,
      last_hit_at TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_type ON learned_patterns(pattern_type);
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_active ON learned_patterns(is_active);
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_accuracy ON learned_patterns(accuracy);
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_priority ON learned_patterns(priority);
  `);

  // Table for pattern learning runs
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_learning_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      logs_analyzed INTEGER DEFAULT 0,
      patterns_generated INTEGER DEFAULT 0,
      patterns_validated INTEGER DEFAULT 0,
      patterns_added INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_learning_runs_status ON pattern_learning_runs(status);
  `);

  logger.info('Pattern learning tables initialized');
}

/**
 * Get database instance
 */
function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Pattern learning database not initialized. Call initPatternLearningTables first.');
  }
  return dbInstance;
}

// ==========================================
// LLM EXTRACTION LOGGING
// ==========================================

/**
 * Log an LLM extraction for pattern learning
 */
export function logLLMExtraction(data: {
  messageId: string;
  rawMessage: string;
  eventType: string;
  extractedTitle?: string | null;
  extractedTime?: string | null;
  extractedDate?: string | null;
  extractedParticipants?: string[];
  llmModel: string;
  llmTokensUsed: number;
  llmLatencyMs: number;
  confidence: number;
  ruleEngineTried?: boolean;
  ruleEngineConfidence?: number;
}): void {
  const db = getDb();
  const id = `llm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const stmt = db.prepare(`
    INSERT INTO llm_extraction_logs (
      id, message_id, raw_message, normalized_message, event_type,
      extracted_title, extracted_time, extracted_date, extracted_participants,
      llm_model, llm_tokens_used, llm_latency_ms, confidence,
      rule_engine_tried, rule_engine_confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    id,
    data.messageId,
    data.rawMessage,
    data.rawMessage.toLowerCase().trim(),
    data.eventType,
    data.extractedTitle || null,
    data.extractedTime || null,
    data.extractedDate || null,
    data.extractedParticipants ? JSON.stringify(data.extractedParticipants) : null,
    data.llmModel,
    data.llmTokensUsed,
    data.llmLatencyMs,
    data.confidence,
    data.ruleEngineTried ? 1 : 0,
    data.ruleEngineConfidence || 0,
    getISTTimestamp()
  );
  
  logger.debug('LLM extraction logged', { id, messageId: data.messageId, eventType: data.eventType });
}

/**
 * Get LLM extraction logs for analysis
 */
export function getLLMExtractionLogs(options: {
  limit?: number;
  minConfidence?: number;
  eventType?: string;
  since?: string;
}): LLMExtractionLog[] {
  const db = getDb();
  const { limit = 1000, minConfidence = 0.7, eventType, since } = options;
  
  let query = `
    SELECT * FROM llm_extraction_logs 
    WHERE confidence >= ?
  `;
  const params: (string | number)[] = [minConfidence];
  
  if (eventType) {
    query += ' AND event_type = ?';
    params.push(eventType);
  }
  
  if (since) {
    query += ' AND created_at >= ?';
    params.push(since);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);
  
  const stmt = db.prepare(query);
  return stmt.all(...params) as LLMExtractionLog[];
}

// ==========================================
// LEARNED PATTERNS MANAGEMENT
// ==========================================

/**
 * Store a new learned pattern
 */
export function storeLearnedPattern(pattern: {
  type: 'time' | 'date' | 'action' | 'participant';
  regex: string;
  captureGroups?: Record<string, string>;
  examples: string[];
  createdFromLogs: string[];
}): string | null {
  const db = getDb();
  const id = `pat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Check if pattern already exists
  const existing = db.prepare('SELECT id FROM learned_patterns WHERE regex_pattern = ?').get(pattern.regex);
  if (existing) {
    logger.debug('Pattern already exists', { regex: pattern.regex });
    return null;
  }
  
  const stmt = db.prepare(`
    INSERT INTO learned_patterns (
      id, pattern_type, regex_pattern, capture_groups, examples,
      hit_count, miss_count, accuracy, is_active, created_from_logs,
      created_at, last_validated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const now = getISTTimestamp();
  
  stmt.run(
    id,
    pattern.type,
    pattern.regex,
    pattern.captureGroups ? JSON.stringify(pattern.captureGroups) : null,
    JSON.stringify(pattern.examples),
    0,
    0,
    1.0, // Start with 100% accuracy (no misses yet)
    1,   // Active by default
    JSON.stringify(pattern.createdFromLogs),
    now,
    now
  );
  
  logger.info('Learned pattern stored', { id, type: pattern.type, regex: pattern.regex });
  return id;
}

/**
 * Get all active learned patterns
 */
export function getActiveLearnedPatterns(): LearnedPattern[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM learned_patterns 
    WHERE is_active = 1 AND accuracy >= 0.6
    ORDER BY priority DESC, accuracy DESC
  `);
  return stmt.all() as LearnedPattern[];
}

/**
 * Get learned patterns by type
 */
export function getLearnedPatternsByType(type: 'time' | 'date' | 'action' | 'participant'): LearnedPattern[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM learned_patterns 
    WHERE pattern_type = ? AND is_active = 1
    ORDER BY priority DESC, accuracy DESC
  `);
  return stmt.all(type) as LearnedPattern[];
}

/**
 * Update pattern hit/miss counts
 */
export function updatePatternStats(patternId: string, hit: boolean): void {
  const db = getDb();
  const now = getISTTimestamp();
  
  if (hit) {
    db.prepare(`
      UPDATE learned_patterns 
      SET hit_count = hit_count + 1, 
          accuracy = CAST(hit_count + 1 AS REAL) / (hit_count + 1 + miss_count),
          last_hit_at = ?
      WHERE id = ?
    `).run(now, patternId);
  } else {
    db.prepare(`
      UPDATE learned_patterns 
      SET miss_count = miss_count + 1,
          accuracy = CAST(hit_count AS REAL) / (hit_count + miss_count + 1)
      WHERE id = ?
    `).run(patternId);
  }
  
  // Deactivate patterns with accuracy < 50% after 10+ attempts
  db.prepare(`
    UPDATE learned_patterns 
    SET is_active = 0 
    WHERE id = ? AND accuracy < 0.5 AND (hit_count + miss_count) >= 10
  `).run(patternId);
}

/**
 * Deactivate a pattern
 */
export function deactivatePattern(patternId: string): void {
  const db = getDb();
  db.prepare('UPDATE learned_patterns SET is_active = 0 WHERE id = ?').run(patternId);
  logger.info('Pattern deactivated', { patternId });
}

// ==========================================
// PATTERN LEARNING ALGORITHM
// ==========================================

/**
 * Main pattern learning function
 * Analyzes LLM extraction logs and generates new patterns
 */
export async function runPatternLearning(): Promise<{
  logsAnalyzed: number;
  patternsGenerated: number;
  patternsAdded: number;
}> {
  const db = getDb();
  const runId = `run_${Date.now()}`;
  const startTime = getISTTimestamp();
  
  // Record the run
  db.prepare(`
    INSERT INTO pattern_learning_runs (id, started_at, status)
    VALUES (?, ?, 'running')
  `).run(runId, startTime);
  
  logger.info('Starting pattern learning run', { runId });
  
  try {
    // Get recent high-confidence LLM extractions
    const logs = getLLMExtractionLogs({
      limit: 500,
      minConfidence: 0.8,
    });
    
    if (logs.length < 10) {
      logger.info('Not enough logs for pattern learning', { count: logs.length });
      db.prepare(`
        UPDATE pattern_learning_runs 
        SET completed_at = ?, status = 'skipped', logs_analyzed = ?
        WHERE id = ?
      `).run(getISTTimestamp(), logs.length, runId);
      return { logsAnalyzed: logs.length, patternsGenerated: 0, patternsAdded: 0 };
    }
    
    // Analyze patterns
    const candidates = analyzeLogsForPatterns(logs);
    
    // Validate and store patterns
    let patternsAdded = 0;
    for (const candidate of candidates) {
      const isValid = validatePattern(candidate, logs);
      
      if (isValid) {
        const patternId = storeLearnedPattern({
          type: candidate.type,
          regex: candidate.pattern,
          examples: candidate.examples,
          createdFromLogs: logs.slice(0, 10).map(l => l.id),
        });
        
        if (patternId) {
          patternsAdded++;
        }
      }
    }
    
    // Update run record
    db.prepare(`
      UPDATE pattern_learning_runs 
      SET completed_at = ?, status = 'completed', 
          logs_analyzed = ?, patterns_generated = ?, patterns_added = ?
      WHERE id = ?
    `).run(getISTTimestamp(), logs.length, candidates.length, patternsAdded, runId);
    
    logger.info('Pattern learning completed', {
      runId,
      logsAnalyzed: logs.length,
      patternsGenerated: candidates.length,
      patternsAdded,
    });
    
    return {
      logsAnalyzed: logs.length,
      patternsGenerated: candidates.length,
      patternsAdded,
    };
    
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    db.prepare(`
      UPDATE pattern_learning_runs 
      SET completed_at = ?, status = 'failed', error = ?
      WHERE id = ?
    `).run(getISTTimestamp(), errorMsg, runId);
    
    logger.error('Pattern learning failed', { runId, error: errorMsg });
    throw error;
  }
}

/**
 * Analyze extraction logs to find common patterns
 */
function analyzeLogsForPatterns(logs: LLMExtractionLog[]): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  
  // Analyze time patterns
  const timePatterns = analyzeTimePatterns(logs);
  candidates.push(...timePatterns);
  
  // Analyze date patterns
  const datePatterns = analyzeDatePatterns(logs);
  candidates.push(...datePatterns);
  
  // Analyze action patterns
  const actionPatterns = analyzeActionPatterns(logs);
  candidates.push(...actionPatterns);
  
  return candidates;
}

/**
 * Analyze logs for time extraction patterns
 */
function analyzeTimePatterns(logs: LLMExtractionLog[]): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  const timeExamples: Map<string, string[]> = new Map();
  
  for (const log of logs) {
    if (!log.extracted_time) continue;
    
    const message = log.normalized_message;
    
    // Look for time-like patterns in the message
    // This is a simplified analysis - in production you'd use more sophisticated NLP
    
    // Pattern: X baje (Hindi for "at X o'clock")
    const bajeMatch = message.match(/(\d{1,2})\s*baje/i);
    if (bajeMatch) {
      const pattern = '\\b(\\d{1,2})\\s*baje\\b';
      if (!timeExamples.has(pattern)) {
        timeExamples.set(pattern, []);
      }
      timeExamples.get(pattern)!.push(message);
    }
    
    // Pattern: subah/shaam X baje (morning/evening X o'clock)
    const periodMatch = message.match(/(subah|shaam|dopahar|raat)\s*(\d{1,2})\s*baje/i);
    if (periodMatch) {
      const pattern = '\\b(subah|shaam|dopahar|raat)\\s*(\\d{1,2})\\s*baje\\b';
      if (!timeExamples.has(pattern)) {
        timeExamples.set(pattern, []);
      }
      timeExamples.get(pattern)!.push(message);
    }
    
    // Pattern: around X (approximate time)
    const aroundMatch = message.match(/around\s+(\d{1,2})(:\d{2})?\s*(am|pm)?/i);
    if (aroundMatch) {
      const pattern = '\\baround\\s+(\\d{1,2})(:\\d{2})?\\s*(am|pm)?\\b';
      if (!timeExamples.has(pattern)) {
        timeExamples.set(pattern, []);
      }
      timeExamples.get(pattern)!.push(message);
    }
    
    // Pattern: by X pm/am (deadline time)
    const byMatch = message.match(/by\s+(\d{1,2})(:\d{2})?\s*(am|pm)/i);
    if (byMatch) {
      const pattern = '\\bby\\s+(\\d{1,2})(:\\d{2})?\\s*(am|pm)\\b';
      if (!timeExamples.has(pattern)) {
        timeExamples.set(pattern, []);
      }
      timeExamples.get(pattern)!.push(message);
    }
  }
  
  // Convert to candidates (only if we have 3+ examples)
  for (const [pattern, examples] of timeExamples.entries()) {
    if (examples.length >= 3) {
      candidates.push({
        pattern,
        type: 'time',
        examples: examples.slice(0, 10),
        frequency: examples.length,
      });
    }
  }
  
  return candidates;
}

/**
 * Analyze logs for date extraction patterns
 */
function analyzeDatePatterns(logs: LLMExtractionLog[]): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  const dateExamples: Map<string, string[]> = new Map();
  
  for (const log of logs) {
    if (!log.extracted_date) continue;
    
    const message = log.normalized_message;
    
    // Pattern: agle/agli + day (Hindi for "next")
    const agleMatch = message.match(/agl[ei]\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)/i);
    if (agleMatch) {
      const pattern = '\\bagl[ei]\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\\b';
      if (!dateExamples.has(pattern)) {
        dateExamples.set(pattern, []);
      }
      dateExamples.get(pattern)!.push(message);
    }
    
    // Pattern: is/next + weekday (Hindi weekdays)
    const hindiDayMatch = message.match(/\b(is|aaj|kal)\s*(somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\b/i);
    if (hindiDayMatch) {
      const pattern = '\\b(is|aaj|kal)\\s*(somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar)\\b';
      if (!dateExamples.has(pattern)) {
        dateExamples.set(pattern, []);
      }
      dateExamples.get(pattern)!.push(message);
    }
    
    // Pattern: coming + weekday
    const comingMatch = message.match(/coming\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (comingMatch) {
      const pattern = '\\bcoming\\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b';
      if (!dateExamples.has(pattern)) {
        dateExamples.set(pattern, []);
      }
      dateExamples.get(pattern)!.push(message);
    }
    
    // Pattern: end of week/month
    const endOfMatch = message.match(/end\s+of\s+(this\s+)?(week|month)/i);
    if (endOfMatch) {
      const pattern = '\\bend\\s+of\\s+(this\\s+)?(week|month)\\b';
      if (!dateExamples.has(pattern)) {
        dateExamples.set(pattern, []);
      }
      dateExamples.get(pattern)!.push(message);
    }
  }
  
  // Convert to candidates
  for (const [pattern, examples] of dateExamples.entries()) {
    if (examples.length >= 3) {
      candidates.push({
        pattern,
        type: 'date',
        examples: examples.slice(0, 10),
        frequency: examples.length,
      });
    }
  }
  
  return candidates;
}

/**
 * Analyze logs for action/event type patterns
 */
function analyzeActionPatterns(logs: LLMExtractionLog[]): PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  const actionExamples: Map<string, string[]> = new Map();
  
  for (const log of logs) {
    const message = log.normalized_message;
    const eventType = log.event_type;
    
    if (eventType !== 'new_event') continue;
    
    // Pattern: need to + verb
    const needToMatch = message.match(/need\s+to\s+(\w+)/i);
    if (needToMatch) {
      const pattern = '\\bneed\\s+to\\s+(\\w+)\\b';
      if (!actionExamples.has(pattern)) {
        actionExamples.set(pattern, []);
      }
      actionExamples.get(pattern)!.push(message);
    }
    
    // Pattern: have to + verb
    const haveToMatch = message.match(/have\s+to\s+(\w+)/i);
    if (haveToMatch) {
      const pattern = '\\bhave\\s+to\\s+(\\w+)\\b';
      if (!actionExamples.has(pattern)) {
        actionExamples.set(pattern, []);
      }
      actionExamples.get(pattern)!.push(message);
    }
    
    // Pattern: let's + verb
    const letsMatch = message.match(/let'?s\s+(\w+)/i);
    if (letsMatch) {
      const pattern = "\\blet'?s\\s+(\\w+)\\b";
      if (!actionExamples.has(pattern)) {
        actionExamples.set(pattern, []);
      }
      actionExamples.get(pattern)!.push(message);
    }
    
    // Pattern: mujhe + verb + hai/hain (Hindi: I have to...)
    const mujheMatch = message.match(/mujhe\s+(\w+)\s+(karna|karni|jaana|jana)\s*(hai|hain)?/i);
    if (mujheMatch) {
      const pattern = '\\bmujhe\\s+(\\w+)\\s+(karna|karni|jaana|jana)\\s*(hai|hain)?\\b';
      if (!actionExamples.has(pattern)) {
        actionExamples.set(pattern, []);
      }
      actionExamples.get(pattern)!.push(message);
    }
    
    // Pattern: scheduled for
    const scheduledMatch = message.match(/scheduled\s+for/i);
    if (scheduledMatch) {
      const pattern = '\\bscheduled\\s+for\\b';
      if (!actionExamples.has(pattern)) {
        actionExamples.set(pattern, []);
      }
      actionExamples.get(pattern)!.push(message);
    }
  }
  
  // Convert to candidates
  for (const [pattern, examples] of actionExamples.entries()) {
    if (examples.length >= 3) {
      candidates.push({
        pattern,
        type: 'action',
        examples: examples.slice(0, 10),
        frequency: examples.length,
      });
    }
  }
  
  return candidates;
}

/**
 * Validate a pattern candidate against historical data
 */
function validatePattern(candidate: PatternCandidate, logs: LLMExtractionLog[]): boolean {
  try {
    const regex = new RegExp(candidate.pattern, 'i');
    
    let truePositives = 0;
    let falsePositives = 0;
    
    for (const log of logs) {
      const matches = regex.test(log.normalized_message);
      
      if (candidate.type === 'time') {
        const hasExtractedTime = !!log.extracted_time;
        if (matches && hasExtractedTime) truePositives++;
        if (matches && !hasExtractedTime) falsePositives++;
      } else if (candidate.type === 'date') {
        const hasExtractedDate = !!log.extracted_date;
        if (matches && hasExtractedDate) truePositives++;
        if (matches && !hasExtractedDate) falsePositives++;
      } else if (candidate.type === 'action') {
        const isNewEvent = log.event_type === 'new_event';
        if (matches && isNewEvent) truePositives++;
        if (matches && !isNewEvent) falsePositives++;
      }
    }
    
    // Need at least 70% precision
    const precision = truePositives / (truePositives + falsePositives || 1);
    
    logger.debug('Pattern validation result', {
      pattern: candidate.pattern,
      type: candidate.type,
      truePositives,
      falsePositives,
      precision: Math.round(precision * 100),
    });
    
    return precision >= 0.7 && truePositives >= 3;
    
  } catch (error) {
    logger.warn('Invalid regex pattern', { pattern: candidate.pattern, error });
    return false;
  }
}

// ==========================================
// PATTERN LOADING FOR RULE ENGINE
// ==========================================

/**
 * Get compiled regex patterns for the rule engine
 */
export function getCompiledLearnedPatterns(): {
  time: { pattern: RegExp; id: string }[];
  date: { pattern: RegExp; id: string }[];
  action: { pattern: RegExp; id: string }[];
} {
  const patterns = getActiveLearnedPatterns();
  
  const result = {
    time: [] as { pattern: RegExp; id: string }[],
    date: [] as { pattern: RegExp; id: string }[],
    action: [] as { pattern: RegExp; id: string }[],
  };
  
  for (const p of patterns) {
    try {
      const regex = new RegExp(p.regex_pattern, 'i');
      
      if (p.pattern_type === 'time') {
        result.time.push({ pattern: regex, id: p.id });
      } else if (p.pattern_type === 'date') {
        result.date.push({ pattern: regex, id: p.id });
      } else if (p.pattern_type === 'action') {
        result.action.push({ pattern: regex, id: p.id });
      }
    } catch (error) {
      logger.warn('Failed to compile learned pattern', { id: p.id, regex: p.regex_pattern });
    }
  }
  
  logger.debug('Loaded learned patterns for rule engine', {
    time: result.time.length,
    date: result.date.length,
    action: result.action.length,
  });
  
  return result;
}

// ==========================================
// STATISTICS AND MONITORING
// ==========================================

/**
 * Get pattern learning statistics
 */
export function getPatternLearningStats(): {
  totalLogs: number;
  recentLogs: number;
  totalPatterns: number;
  activePatterns: number;
  avgPatternAccuracy: number;
  totalHits: number;
  totalMisses: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
} {
  const db = getDb();
  
  const logStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as recent
    FROM llm_extraction_logs
  `).get() as { total: number; recent: number };
  
  const patternStats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
      AVG(CASE WHEN is_active = 1 THEN accuracy ELSE NULL END) as avgAccuracy,
      SUM(hit_count) as totalHits,
      SUM(miss_count) as totalMisses
    FROM learned_patterns
  `).get() as { total: number; active: number; avgAccuracy: number; totalHits: number; totalMisses: number };
  
  const lastRun = db.prepare(`
    SELECT completed_at, status FROM pattern_learning_runs 
    ORDER BY started_at DESC LIMIT 1
  `).get() as { completed_at: string; status: string } | undefined;
  
  return {
    totalLogs: logStats.total || 0,
    recentLogs: logStats.recent || 0,
    totalPatterns: patternStats.total || 0,
    activePatterns: patternStats.active || 0,
    avgPatternAccuracy: Math.round((patternStats.avgAccuracy || 0) * 100) / 100,
    totalHits: patternStats.totalHits || 0,
    totalMisses: patternStats.totalMisses || 0,
    lastRunAt: lastRun?.completed_at || null,
    lastRunStatus: lastRun?.status || null,
  };
}

/**
 * Get all learned patterns (for admin view)
 */
export function getAllLearnedPatterns(): LearnedPattern[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM learned_patterns ORDER BY accuracy DESC, hit_count DESC');
  return stmt.all() as LearnedPattern[];
}

export default {
  initPatternLearningTables,
  logLLMExtraction,
  getLLMExtractionLogs,
  storeLearnedPattern,
  getActiveLearnedPatterns,
  getLearnedPatternsByType,
  updatePatternStats,
  deactivatePattern,
  runPatternLearning,
  getCompiledLearnedPatterns,
  getPatternLearningStats,
  getAllLearnedPatterns,
};
