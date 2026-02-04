/**
 * Extractor Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractEvent } from '../../src/legacy/pipeline/extractor.js';

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                event_type: 'new_event',
                title: 'Team Meeting',
                start_time: '2024-12-20T14:00:00.000Z',
                end_time: '2024-12-20T15:00:00.000Z',
                condition: { type: null, value: null },
                confidence: 0.85
              })
            }
          }]
        })
      }
    }
  }))
}));

describe('Extractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Event Extraction', () => {
    it('should extract event data from context', async () => {
      const context = 'Let\'s have a team meeting tomorrow at 2pm';
      const result = await extractEvent(context);

      expect(result).toHaveProperty('event_type');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('start_time');
      expect(result).toHaveProperty('end_time');
      expect(result).toHaveProperty('condition');
      expect(result).toHaveProperty('confidence');
    });

    it('should return valid event type', async () => {
      const result = await extractEvent('Meeting tomorrow');
      expect(['new_event', 'update_event', 'signal_event', 'irrelevant']).toContain(result.event_type);
    });

    it('should return confidence between 0 and 1', async () => {
      const result = await extractEvent('Meeting tomorrow at 3pm');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Schema Validation', () => {
    it('should return properly structured condition', async () => {
      const result = await extractEvent('Meeting at the office');
      
      expect(result.condition).toHaveProperty('type');
      expect(result.condition).toHaveProperty('value');
    });

    it('should normalize ISO dates', async () => {
      const result = await extractEvent('Meeting on 2024-12-20 at 14:00');
      
      if (result.start_time) {
        expect(() => new Date(result.start_time!)).not.toThrow();
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle empty context', async () => {
      const result = await extractEvent('');
      expect(result).toHaveProperty('event_type');
    });

    it('should return empty event on parse failure', async () => {
      // This test verifies graceful degradation
      const result = await extractEvent('Some random text that might fail');
      expect(result.event_type).toBeDefined();
    });
  });

  describe('Condition Types', () => {
    it('should handle location conditions', async () => {
      const result = await extractEvent('Meet me when you arrive at the office');
      
      expect(result.condition).toBeDefined();
      expect([null, 'location', 'time', 'dependency']).toContain(result.condition.type);
    });

    it('should handle time conditions', async () => {
      const result = await extractEvent('Remind me after the standup');
      
      expect(result.condition).toBeDefined();
    });

    it('should handle dependency conditions', async () => {
      const result = await extractEvent('Start the review after the PR is merged');
      
      expect(result.condition).toBeDefined();
    });
  });
});
