/**
 * Pattern Learner Tests
 * 
 * Tests for the auto-learning system that generates regex patterns
 * from LLM extraction logs.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  initPatternLearningTables,
  logLLMExtraction,
  getLLMExtractionLogs,
  storeLearnedPattern,
  getActiveLearnedPatterns,
  getLearnedPatternsByType,
  updatePatternStats,
  deactivatePattern,
  getPatternLearningStats,
  getAllLearnedPatterns,
  getCompiledLearnedPatterns,
} from '../../src/legacy/pipeline/patternLearner.js';

// Create in-memory database for tests
let db: Database.Database;

beforeAll(() => {
  db = new Database(':memory:');
  initPatternLearningTables(db);
});

beforeEach(() => {
  // Clear tables before each test
  db.exec('DELETE FROM llm_extraction_logs');
  db.exec('DELETE FROM learned_patterns');
  db.exec('DELETE FROM pattern_learning_runs');
});

describe('Pattern Learner', () => {
  describe('LLM Extraction Logging', () => {
    it('should log LLM extraction', () => {
      logLLMExtraction({
        messageId: 'msg_001',
        rawMessage: 'meeting tomorrow at 3pm',
        eventType: 'new_event',
        extractedTitle: 'Meeting',
        extractedTime: '2026-02-03T09:30:00.000Z',
        extractedDate: '2026-02-03',
        extractedParticipants: ['John'],
        llmModel: 'gpt-4o',
        llmTokensUsed: 150,
        llmLatencyMs: 500,
        confidence: 0.9,
        ruleEngineTried: true,
        ruleEngineConfidence: 0.5,
      });

      const logs = getLLMExtractionLogs({ limit: 10, minConfidence: 0.5 });
      expect(logs).toHaveLength(1);
      expect(logs[0].message_id).toBe('msg_001');
      expect(logs[0].event_type).toBe('new_event');
      expect(logs[0].confidence).toBe(0.9);
    });

    it('should filter logs by minimum confidence', () => {
      logLLMExtraction({
        messageId: 'msg_001',
        rawMessage: 'test message 1',
        eventType: 'new_event',
        llmModel: 'gpt-4o',
        llmTokensUsed: 100,
        llmLatencyMs: 300,
        confidence: 0.9,
      });

      logLLMExtraction({
        messageId: 'msg_002',
        rawMessage: 'test message 2',
        eventType: 'new_event',
        llmModel: 'gpt-4o',
        llmTokensUsed: 100,
        llmLatencyMs: 300,
        confidence: 0.3,
      });

      const highConfLogs = getLLMExtractionLogs({ minConfidence: 0.7 });
      expect(highConfLogs).toHaveLength(1);
      expect(highConfLogs[0].message_id).toBe('msg_001');

      const allLogs = getLLMExtractionLogs({ minConfidence: 0.1 });
      expect(allLogs).toHaveLength(2);
    });

    it('should filter logs by event type', () => {
      logLLMExtraction({
        messageId: 'msg_001',
        rawMessage: 'new meeting',
        eventType: 'new_event',
        llmModel: 'gpt-4o',
        llmTokensUsed: 100,
        llmLatencyMs: 300,
        confidence: 0.9,
      });

      logLLMExtraction({
        messageId: 'msg_002',
        rawMessage: 'cancel meeting',
        eventType: 'update_event',
        llmModel: 'gpt-4o',
        llmTokensUsed: 100,
        llmLatencyMs: 300,
        confidence: 0.9,
      });

      const newEventLogs = getLLMExtractionLogs({ eventType: 'new_event', minConfidence: 0.5 });
      expect(newEventLogs).toHaveLength(1);
      expect(newEventLogs[0].event_type).toBe('new_event');
    });
  });

  describe('Learned Patterns Storage', () => {
    it('should store a learned pattern', () => {
      const patternId = storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        captureGroups: { '1': 'hour' },
        examples: ['3 baje', '5 baje', '10 baje'],
        createdFromLogs: ['log_001', 'log_002'],
      });

      expect(patternId).toBeTruthy();
      
      const patterns = getActiveLearnedPatterns();
      expect(patterns).toHaveLength(1);
      expect(patterns[0].pattern_type).toBe('time');
      expect(patterns[0].regex_pattern).toBe('\\b(\\d{1,2})\\s*baje\\b');
    });

    it('should prevent duplicate patterns', () => {
      const id1 = storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['3 baje'],
        createdFromLogs: ['log_001'],
      });

      const id2 = storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['5 baje'],
        createdFromLogs: ['log_002'],
      });

      expect(id1).toBeTruthy();
      expect(id2).toBeNull(); // Duplicate, returns null
      
      const patterns = getActiveLearnedPatterns();
      expect(patterns).toHaveLength(1);
    });

    it('should get patterns by type', () => {
      storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['3 baje'],
        createdFromLogs: ['log_001'],
      });

      storeLearnedPattern({
        type: 'date',
        regex: '\\bagle\\s+(monday|tuesday)\\b',
        examples: ['agle monday'],
        createdFromLogs: ['log_002'],
      });

      const timePatterns = getLearnedPatternsByType('time');
      expect(timePatterns).toHaveLength(1);
      expect(timePatterns[0].pattern_type).toBe('time');

      const datePatterns = getLearnedPatternsByType('date');
      expect(datePatterns).toHaveLength(1);
      expect(datePatterns[0].pattern_type).toBe('date');
    });
  });

  describe('Pattern Statistics', () => {
    it('should update hit count', () => {
      const patternId = storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['3 baje'],
        createdFromLogs: ['log_001'],
      });

      updatePatternStats(patternId!, true); // Hit
      updatePatternStats(patternId!, true); // Hit
      updatePatternStats(patternId!, false); // Miss

      const patterns = getAllLearnedPatterns();
      expect(patterns[0].hit_count).toBe(2);
      expect(patterns[0].miss_count).toBe(1);
      expect(patterns[0].accuracy).toBeCloseTo(0.67, 1);
    });

    it('should deactivate low accuracy patterns', () => {
      const patternId = storeLearnedPattern({
        type: 'time',
        regex: '\\bbad\\s*pattern\\b',
        examples: ['bad pattern'],
        createdFromLogs: ['log_001'],
      });

      // 3 hits, 8 misses = 27% accuracy
      for (let i = 0; i < 3; i++) updatePatternStats(patternId!, true);
      for (let i = 0; i < 8; i++) updatePatternStats(patternId!, false);

      const patterns = getActiveLearnedPatterns();
      expect(patterns).toHaveLength(0); // Should be deactivated
    });

    it('should deactivate pattern manually', () => {
      const patternId = storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['3 baje'],
        createdFromLogs: ['log_001'],
      });

      deactivatePattern(patternId!);

      const patterns = getActiveLearnedPatterns();
      expect(patterns).toHaveLength(0);
    });
  });

  describe('Pattern Compilation', () => {
    it('should compile patterns into regex objects', () => {
      storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['3 baje'],
        createdFromLogs: ['log_001'],
      });

      storeLearnedPattern({
        type: 'date',
        regex: '\\bagle\\s+(monday|tuesday)\\b',
        examples: ['agle monday'],
        createdFromLogs: ['log_002'],
      });

      storeLearnedPattern({
        type: 'action',
        regex: '\\bneed\\s+to\\b',
        examples: ['need to call'],
        createdFromLogs: ['log_003'],
      });

      const compiled = getCompiledLearnedPatterns();
      
      expect(compiled.time).toHaveLength(1);
      expect(compiled.date).toHaveLength(1);
      expect(compiled.action).toHaveLength(1);
      
      // Test that patterns work
      expect(compiled.time[0].pattern.test('3 baje milte hain')).toBe(true);
      expect(compiled.date[0].pattern.test('agle monday ko')).toBe(true);
      expect(compiled.action[0].pattern.test('need to call mom')).toBe(true);
    });

    it('should skip invalid regex patterns', () => {
      // Insert invalid regex directly into DB
      db.prepare(`
        INSERT INTO learned_patterns (id, pattern_type, regex_pattern, examples, is_active, accuracy)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('pat_invalid', 'time', '\\b(unclosed', '[]', 1, 1.0);

      // Should not throw, just skip the invalid pattern
      const compiled = getCompiledLearnedPatterns();
      expect(compiled.time).toHaveLength(0);
    });
  });

  describe('Statistics', () => {
    it('should return correct learning stats', () => {
      // Add some logs
      for (let i = 0; i < 5; i++) {
        logLLMExtraction({
          messageId: `msg_${i}`,
          rawMessage: `test message ${i}`,
          eventType: 'new_event',
          llmModel: 'gpt-4o',
          llmTokensUsed: 100,
          llmLatencyMs: 300,
          confidence: 0.9,
        });
      }

      // Add a pattern
      storeLearnedPattern({
        type: 'time',
        regex: '\\b(\\d{1,2})\\s*baje\\b',
        examples: ['3 baje'],
        createdFromLogs: ['log_001'],
      });

      // Update stats
      const patternId = getAllLearnedPatterns()[0].id;
      updatePatternStats(patternId, true);
      updatePatternStats(patternId, true);

      const stats = getPatternLearningStats();
      
      expect(stats.totalLogs).toBe(5);
      expect(stats.totalPatterns).toBe(1);
      expect(stats.activePatterns).toBe(1);
      expect(stats.totalHits).toBe(2);
      expect(stats.totalMisses).toBe(0);
    });
  });
});
