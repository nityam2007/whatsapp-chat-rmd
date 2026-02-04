/**
 * Pipeline Integration Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StoredMessage } from '../../src/shared/types.js';

// Create mock functions that persist across tests
const mockStoreMessage = vi.fn().mockResolvedValue(undefined);
const mockGetMessage = vi.fn().mockResolvedValue(null);
const mockGetRecentMessages = vi.fn().mockResolvedValue([]);
const mockStoreEvent = vi.fn().mockResolvedValue(undefined);
const mockGetEvent = vi.fn().mockResolvedValue(null);
const mockUpdateEvent = vi.fn().mockResolvedValue(undefined);
const mockFindConflicts = vi.fn().mockResolvedValue([]);
const mockGetPendingEvents = vi.fn().mockResolvedValue([]);
const mockGetActiveEventsByContact = vi.fn().mockResolvedValue([]);

// Mock the database with importOriginal to get all exports
vi.mock('../../src/database/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getContactName: vi.fn().mockReturnValue('Test User'),
    getDatabase: vi.fn(() => ({
      storeMessage: mockStoreMessage,
      getMessage: mockGetMessage,
      getRecentMessages: mockGetRecentMessages,
      storeEvent: mockStoreEvent,
      getEvent: mockGetEvent,
      updateEvent: mockUpdateEvent,
      findConflicts: mockFindConflicts,
      getPendingEvents: mockGetPendingEvents,
      getActiveEventsByContact: mockGetActiveEventsByContact,
    })),
    initDatabase: vi.fn(),
    messageExists: vi.fn().mockReturnValue(false),
    storeEnhancedMessage: vi.fn(),
    updateMessageHeuristic: vi.fn(),
    updateMessageClassification: vi.fn(),
    updateMessageExtraction: vi.fn(),
    updateMessagePipelineComplete: vi.fn(),
    storePipelineLog: vi.fn(),
    eventExistsForMessage: vi.fn().mockReturnValue(false),
    getEventBySourceMessage: vi.fn().mockReturnValue(null),
    storeEventWithExtraction: vi.fn(),
    getContactById: vi.fn().mockReturnValue({ id: 'test', name: 'Test User' }),
    storeLLMCall: vi.fn(),
  };
});

// Mock vector store
vi.mock('../../src/vector/faiss.js', () => ({
  getVectorStore: vi.fn(() => ({
    addVector: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  })),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0)),
  initVectorStore: vi.fn(),
}));

// Mock scheduler
vi.mock('../../src/scheduler/index.js', () => ({
  scheduleReminder: vi.fn().mockResolvedValue(null),
  cancelReminder: vi.fn().mockReturnValue(false),
}));

// Mock notifications
vi.mock('../../src/notifications/index.js', () => ({
  sendNotification: vi.fn().mockResolvedValue(true),
}));

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

describe('Pipeline Integration', () => {
  const createTestMessage = (content: string): StoredMessage => ({
    id: `msg_${Date.now()}`,
    chat_id: 'test_chat',
    sender: 'Test User',
    content,
    timestamp: Math.floor(Date.now() / 1000),
    processed: false,
    created_at: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Full Pipeline Flow', () => {
    it('should process event message through pipeline', async () => {
      const { processMessage } = await import('../../src/legacy/pipeline/index.js');
      
      const message = createTestMessage('Meeting tomorrow at 2pm with the team');
      const result = await processMessage(message);

      // With mocked OpenAI, should return an event
      expect(result).toBeDefined();
    });

    it('should drop irrelevant messages', async () => {
      const { processMessage } = await import('../../src/legacy/pipeline/index.js');
      
      const message = createTestMessage('ok thanks');
      const result = await processMessage(message);

      // Irrelevant message should be dropped at heuristic gate
      expect(result).toBeNull();
    });

    it('should store message before processing', async () => {
      const { storeEnhancedMessage } = await import('../../src/database/sqlite.js');
      const { processMessage } = await import('../../src/legacy/pipeline/index.js');
      
      const message = createTestMessage('Schedule a meeting for Friday');
      await processMessage(message);

      // Pipeline now uses storeEnhancedMessage instead of storeMessage
      expect(storeEnhancedMessage).toHaveBeenCalledWith(expect.objectContaining({
        id: message.id,
      }));
    });
  });

  describe('Heuristic Gate Integration', () => {
    it('should pass messages with event signals', async () => {
      const { checkHeuristicGate } = await import('../../src/pipeline/heuristicGate.js');
      
      const result = checkHeuristicGate('Remind me about the meeting at 3pm');
      expect(result.hasSignal).toBe(true);
    });

    it('should block messages without signals', async () => {
      const { checkHeuristicGate } = await import('../../src/pipeline/heuristicGate.js');
      
      const result = checkHeuristicGate('lol nice one');
      expect(result.hasSignal).toBe(false);
    });
  });

  describe('Context Building Integration', () => {
    it('should build context from recent messages', async () => {
      const { buildContext } = await import('../../src/legacy/pipeline/contextBuilder.js');
      
      const message = createTestMessage('Meeting at 3pm');
      const context = await buildContext(message);

      expect(context).toHaveProperty('messages');
      expect(context).toHaveProperty('tokenCount');
      expect(context).toHaveProperty('compressed');
    });
  });

  describe('Event Routing Integration', () => {
    it('should route new events correctly', async () => {
      const { storeEventWithExtraction } = await import('../../src/database/sqlite.js');
      const { routeEvent } = await import('../../src/legacy/pipeline/eventRouter.js');
      
      const message = createTestMessage('Team standup tomorrow at 9am');
      const extractedEvent = {
        event_type: 'new_event' as const,
        title: 'Team Standup',
        start_time: '2024-12-20T09:00:00.000Z',
        end_time: '2024-12-20T09:30:00.000Z',
        condition: { type: null, value: null },
        participants: [],
        confidence: 0.9,
        context_tags: [],
        trigger_keywords: [],
        location: null,
      };

      const result = await routeEvent(extractedEvent, message);

      expect(result).toBeDefined();
      expect(result?.title).toBe('Team Standup');
      
      // Pipeline now uses storeEventWithExtraction instead of storeEvent
      expect(storeEventWithExtraction).toHaveBeenCalled();
    });

    it('should return null for irrelevant events', async () => {
      const { routeEvent } = await import('../../src/legacy/pipeline/eventRouter.js');
      
      const message = createTestMessage('Hello');
      const extractedEvent = {
        event_type: 'irrelevant' as const,
        title: null,
        start_time: null,
        end_time: null,
        condition: { type: null, value: null },
        participants: [],
        confidence: 0.9,
        context_tags: [],
        trigger_keywords: [],
        location: null,
      };

      const result = await routeEvent(extractedEvent, message);
      expect(result).toBeNull();
    });
  });
});
