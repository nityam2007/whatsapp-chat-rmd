/**
 * API Integration Tests
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// Mock all external dependencies with importOriginal
vi.mock('../../src/database/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getDatabase: vi.fn(() => ({
      storeMessage: vi.fn().mockResolvedValue(undefined),
      getMessage: vi.fn().mockResolvedValue(null),
      getRecentMessages: vi.fn().mockResolvedValue([]),
      storeEvent: vi.fn().mockResolvedValue(undefined),
      getEvent: vi.fn().mockResolvedValue(null),
      updateEvent: vi.fn().mockResolvedValue(undefined),
      findConflicts: vi.fn().mockResolvedValue([]),
      getPendingEvents: vi.fn().mockResolvedValue([]),
      getActiveEventsByContact: vi.fn().mockResolvedValue([]),
    })),
    initDatabase: vi.fn(),
    getISTTimestamp: vi.fn().mockReturnValue('2024-12-20T10:00:00+05:30'),
    formatISTDate: vi.fn().mockReturnValue('20 Dec 2024, 10:00 am'),
    formatISTForStorage: vi.fn().mockReturnValue('2024-12-20T10:00:00+05:30'),
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
    getEvents: vi.fn().mockReturnValue({ events: [], total: 0 }),
    getEventById: vi.fn().mockReturnValue(null),
    updateEventStatus: vi.fn().mockReturnValue(null),
    deleteEvent: vi.fn().mockReturnValue(false),
    getUpcomingEvents: vi.fn().mockReturnValue([]),
    getEventStats: vi.fn().mockReturnValue({ total: 0, byStatus: {} }),
    getMessageStats: vi.fn().mockReturnValue({ total: 0, processed: 0 }),
    archiveOldData: vi.fn().mockReturnValue({ archived: 0 }),
    getArchiveMetadata: vi.fn().mockReturnValue([]),
    getPipelineLogs: vi.fn().mockReturnValue([]),
    getAllContacts: vi.fn().mockReturnValue([]),
    getTopContacts: vi.fn().mockReturnValue([]),
    getEventsByContact: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockReturnValue({ messages: [], total: 0 }),
    upsertContact: vi.fn(),
  };
});

vi.mock('../../src/vector/faiss.js', () => ({
  getVectorStore: vi.fn(() => ({
    addVector: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  })),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(256).fill(0)),
  initVectorStore: vi.fn(),
}));

vi.mock('../../src/scheduler/index.js', () => ({
  scheduleReminder: vi.fn().mockResolvedValue(null),
  cancelReminder: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/notifications/index.js', () => ({
  sendNotification: vi.fn().mockResolvedValue(true),
  getNotificationHistory: vi.fn().mockReturnValue([]),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: JSON.stringify({
                event_type: 'new_event',
                title: 'Meeting',
                start_time: null,
                end_time: null,
                condition: { type: null, value: null },
                confidence: 0.8
              })
            }
          }]
        })
      }
    }
  }))
}));

describe('API Integration', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createServer } = await import('../../src/server.js');
    app = createServer();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Root Endpoint', () => {
    it('should return service info', async () => {
      const response = await request(app).get('/');
      
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('name', 'WhatsApp Chat RMD');
      expect(response.body).toHaveProperty('status', 'running');
    });
  });

  describe('Webhook Endpoints', () => {
    describe('POST /webhook/evolution', () => {
      it('should accept valid webhook payload', async () => {
        const payload = {
          event: 'messages.upsert',
          instance: 'test-instance',
          data: {
            key: {
              remoteJid: '1234567890@s.whatsapp.net',
              fromMe: false,
              id: 'msg123',
            },
            pushName: 'Test User',
            message: {
              conversation: 'Meeting tomorrow at 2pm',
            },
            messageType: 'conversation',
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        };

        const response = await request(app)
          .post('/webhook/evolution')
          .send(payload);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'processing');
      });

      it('should reject invalid payload', async () => {
        const response = await request(app)
          .post('/webhook/evolution')
          .send({});

        expect(response.status).toBe(400);
      });

      it('should ignore own messages', async () => {
        const payload = {
          event: 'messages.upsert',
          instance: 'test-instance',
          data: {
            key: {
              remoteJid: '1234567890@s.whatsapp.net',
              fromMe: true,
              id: 'msg123',
            },
            message: {
              conversation: 'Hello',
            },
            messageType: 'conversation',
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        };

        const response = await request(app)
          .post('/webhook/evolution')
          .send(payload);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'ignored');
      });

      it('should ignore non-message events', async () => {
        const payload = {
          event: 'connection.update',
          instance: 'test-instance',
          data: {},
        };

        const response = await request(app)
          .post('/webhook/evolution')
          .send(payload);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'ignored');
      });
    });

    describe('GET /webhook/health', () => {
      it('should return health status', async () => {
        const response = await request(app).get('/webhook/health');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'ok');
      });
    });

    describe('POST /webhook/test', () => {
      it('should process test message', async () => {
        const response = await request(app)
          .post('/webhook/test')
          .send({
            content: 'Meeting tomorrow at 3pm',
            chat_id: 'test-chat',
            sender: 'Test User',
          });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('status', 'completed');
      });

      it('should require content', async () => {
        const response = await request(app)
          .post('/webhook/test')
          .send({});

        expect(response.status).toBe(400);
      });
    });
  });

  describe('API Endpoints', () => {
    describe('GET /api/events', () => {
      it('should return events list', async () => {
        const response = await request(app).get('/api/events');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('events');
        expect(Array.isArray(response.body.events)).toBe(true);
      });
    });

    describe('GET /api/notifications', () => {
      it('should return notification history', async () => {
        const response = await request(app).get('/api/notifications');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('notifications');
      });
    });

    describe('GET /api/metrics', () => {
      it('should return full pipeline metrics', async () => {
        const response = await request(app).get('/api/metrics');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('metrics');
        expect(response.body).toHaveProperty('timestamp');
        
        const { metrics } = response.body;
        expect(metrics).toHaveProperty('messagesProcessed');
        expect(metrics).toHaveProperty('messagesDroppedByHeuristic');
        expect(metrics).toHaveProperty('messagesPassedHeuristic');
        expect(metrics).toHaveProperty('ruleEngineExtractions');
        expect(metrics).toHaveProperty('llmExtractions');
        expect(metrics).toHaveProperty('eventsCreated');
        expect(metrics).toHaveProperty('errors');
        expect(metrics).toHaveProperty('heuristicDropRate');
        expect(metrics).toHaveProperty('ruleEngineHitRate');
        expect(metrics).toHaveProperty('avgTotalLatency');
      });
    });

    describe('GET /api/metrics/summary', () => {
      it('should return human-readable metrics summary', async () => {
        const response = await request(app).get('/api/metrics/summary');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('summary');
        expect(response.body).toHaveProperty('timestamp');
        
        const { summary } = response.body;
        expect(summary).toHaveProperty('uptimeHours');
        expect(summary).toHaveProperty('messagesProcessed');
        expect(summary).toHaveProperty('heuristicDropRate');
        expect(summary).toHaveProperty('ruleEngineHitRate');
        expect(summary).toHaveProperty('llmSkipRate');
        expect(summary).toHaveProperty('avgLatencyMs');
      });

      it('should have percentage-formatted rates', async () => {
        const response = await request(app).get('/api/metrics/summary');
        
        const { summary } = response.body;
        // Rates should be formatted as percentages (e.g., "50%")
        expect(typeof summary.heuristicDropRate).toBe('string');
        expect(summary.heuristicDropRate).toMatch(/^\d+%$/);
      });
    });

    describe('POST /api/metrics/reset', () => {
      it('should reset metrics successfully', async () => {
        const response = await request(app).post('/api/metrics/reset');
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('message', 'Metrics reset successfully');
        expect(response.body).toHaveProperty('timestamp');
      });

      it('should result in zero counters after reset', async () => {
        // First reset
        await request(app).post('/api/metrics/reset');
        
        // Then check metrics
        const response = await request(app).get('/api/metrics');
        
        expect(response.body.metrics.messagesProcessed).toBe(0);
        expect(response.body.metrics.errors).toBe(0);
        expect(response.body.metrics.eventsCreated).toBe(0);
      });
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await request(app).get('/unknown-route');
      
      expect(response.status).toBe(404);
    });

    it('should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/webhook/evolution')
        .set('Content-Type', 'application/json')
        .send('{ invalid json }');

      expect(response.status).toBe(400);
    });
  });
});
