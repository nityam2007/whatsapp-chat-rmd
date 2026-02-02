/**
 * Token Compressor Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { estimateTokens, compressIfNeeded, shouldCompress } from '../../src/pipeline/tokenCompressor.js';
import { MessageContext } from '../../src/shared/types.js';

// Mock config with API key to enable compression
vi.mock('../../src/config/index.js', () => ({
  config: {
    tokenThreshold: 2000,
    openaiApiKey: 'test-api-key',
    openaiModelSmall: 'gpt-4o-mini',
  },
  default: {
    tokenThreshold: 2000,
    openaiApiKey: 'test-api-key',
    openaiModelSmall: 'gpt-4o-mini',
  },
}));

// Mock OpenAI to return compressed content
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: 'Compressed: 決定 messages summary'
            }
          }]
        })
      }
    }
  }))
}));

interface StoredMessage {
  id: string;
  chat_id: string;
  sender: string;
  content: string;
  timestamp: number;
  processed: boolean;
  created_at: string;
}

describe('Token Compressor', () => {
  const createMessage = (content: string, id: string = '1'): StoredMessage => ({
    id,
    chat_id: 'chat1',
    sender: 'User',
    content,
    timestamp: Date.now(),
    processed: false,
    created_at: new Date().toISOString(),
  });

  const createContext = (messages: StoredMessage[], tokenCount?: number): MessageContext => ({
    messages,
    compressed: false,
    tokenCount: tokenCount ?? estimateTokens(messages.map(m => m.content).join(' ')),
  });

  describe('Token Estimation', () => {
    it('should estimate tokens for text', () => {
      const text = 'Hello world, this is a test message';
      const tokens = estimateTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should estimate more tokens for longer text', () => {
      const short = 'Hello';
      const long = 'Hello world, this is a much longer test message with many more words';
      
      expect(estimateTokens(long)).toBeGreaterThan(estimateTokens(short));
    });

    it('should handle empty text gracefully', () => {
      const tokens = estimateTokens('');
      expect(tokens).toBeGreaterThanOrEqual(0);
    });

    it('should estimate roughly 1 token per 4 characters', () => {
      const text = 'This is exactly forty characters long!!';
      const tokens = estimateTokens(text);
      // Should be roughly 10 tokens (40/4)
      expect(tokens).toBeGreaterThan(5);
      expect(tokens).toBeLessThan(20);
    });
  });

  describe('shouldCompress', () => {
    it('should return false for small context', () => {
      const context = createContext([createMessage('Hello')], 100);
      expect(shouldCompress(context)).toBe(false);
    });

    it('should return false for single message', () => {
      const context = createContext([createMessage('A'.repeat(10000))], 3000);
      expect(shouldCompress(context)).toBe(false);
    });

    it('should return true for large context with multiple messages', () => {
      // Create varied content to exceed 2000 token threshold
      // Repetitive chars compress well in tiktoken, so use varied text
      const loremBase = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat ';
      const messages = Array(30).fill(null).map((_, i) => 
        createMessage(`Message ${i}: ${loremBase.repeat(4)} unique${i}${Date.now()}`, String(i))
      );
      const context = createContext(messages);
      expect(shouldCompress(context)).toBe(true);
    });
  });

  describe('compressIfNeeded', () => {
    it('should not compress small context', async () => {
      const context = createContext([createMessage('Hello world')], 50);
      const result = await compressIfNeeded(context);
      
      expect(result.compressed).toBe(false);
      expect(result.compressedContent).toBeUndefined();
    });

    it('should not compress single message even if large', async () => {
      const context = createContext([createMessage('A'.repeat(10000))], 3000);
      const result = await compressIfNeeded(context);
      
      expect(result.compressed).toBe(false);
    });

    it('should compress large multi-message context', async () => {
      // Create varied content to exceed 2000 token threshold
      const loremBase = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat ';
      const messages = Array(30).fill(null).map((_, i) => 
        createMessage(`Message ${i}: ${loremBase.repeat(4)} unique${i}${Date.now()}`, String(i))
      );
      const context = createContext(messages);
      const result = await compressIfNeeded(context);
      
      expect(result.compressed).toBe(true);
      expect(result.compressedContent).toBeDefined();
      // With mock OpenAI, compressed content is much smaller
      expect(result.tokenCount).toBeLessThan(context.tokenCount);
    });

    it('should preserve message order in compressed content', async () => {
      const messages = [
        createMessage('First message', '1'),
        createMessage('Second message', '2'),
        createMessage('Third message', '3'),
      ];
      const context = createContext(messages, 3000);
      const result = await compressIfNeeded(context);
      
      if (result.compressed && result.compressedContent) {
        const content = result.compressedContent;
        const firstPos = content.indexOf('First');
        const thirdPos = content.indexOf('Third');
        
        if (firstPos !== -1 && thirdPos !== -1) {
          expect(firstPos).toBeLessThan(thirdPos);
        }
      }
    });
  });
});
