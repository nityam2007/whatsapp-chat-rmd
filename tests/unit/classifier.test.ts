/**
 * Classifier Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing classifier
vi.mock('../../src/config/index.js', () => ({
  config: {
    openaiApiKey: 'test-key',
    openaiModelSmall: 'gpt-4o-mini',
  },
  default: {
    openaiApiKey: 'test-key',
    openaiModelSmall: 'gpt-4o-mini',
  },
}));

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: '{"event_type": "new_event", "confidence": 0.9}'
            }
          }]
        })
      }
    }
  }))
}));

describe('Classifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Classification Results', () => {
    it('should classify event messages as new_event', async () => {
      const { classifyMessage } = await import('../../src/pipeline/classifier.js');
      const result = await classifyMessage('Let\'s have a meeting tomorrow at 2pm');
      expect(result.event_type).toBe('new_event');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should return valid classification result structure', async () => {
      const { classifyMessage } = await import('../../src/pipeline/classifier.js');
      const result = await classifyMessage('Any message');
      
      expect(result).toHaveProperty('event_type');
      expect(result).toHaveProperty('confidence');
      expect(['new_event', 'update_event', 'signal_event', 'irrelevant']).toContain(result.event_type);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should handle empty messages', async () => {
      const { classifyMessage } = await import('../../src/pipeline/classifier.js');
      const result = await classifyMessage('');
      expect(result).toHaveProperty('event_type');
    });
  });

  describe('With Mocked LLM', () => {
    it('should return mocked classification', async () => {
      const { classifyMessage } = await import('../../src/pipeline/classifier.js');
      const result = await classifyMessage('Meeting tomorrow at 3pm');
      expect(result.event_type).toBe('new_event');
      expect(result.confidence).toBe(0.9);
    });
  });

  describe('Confidence Scores', () => {
    it('should return confidence between 0 and 1', async () => {
      const { classifyMessage } = await import('../../src/pipeline/classifier.js');
      const result = await classifyMessage('Meeting tomorrow');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
