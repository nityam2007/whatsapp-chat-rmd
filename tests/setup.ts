/**
 * Test Setup
 * 
 * Global setup for all tests
 */

import { beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock environment variables
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.LOG_LEVEL = 'error';
process.env.OPENAI_API_KEY = 'test-key';
process.env.REDIS_URL = 'redis://localhost:6379';

// Mock external services
beforeAll(() => {
  // Mock fetch globally if needed
  vi.stubGlobal('fetch', vi.fn());
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

// Extend expect with custom matchers if needed
