/**
 * Shared Types Validation Tests
 */

import { describe, it, expect } from 'vitest';
import {
  ExtractedEventSchema,
  StoredMessageSchema,
  StoredEventSchema,
  ContainerCommandSchema,
  NotificationPayloadSchema,
  PushSubscriptionSchema,
} from '../../src/shared/types.js';

describe('Shared Types Validation', () => {
  describe('ExtractedEventSchema', () => {
    it('should validate valid extracted event', () => {
      const validEvent = {
        event_type: 'new_event',
        title: 'Team Meeting',
        start_time: '2024-12-20T14:00:00.000Z',
        end_time: '2024-12-20T15:00:00.000Z',
        condition: { type: null, value: null },
        confidence: 0.85,
      };

      const result = ExtractedEventSchema.safeParse(validEvent);
      expect(result.success).toBe(true);
    });

    it('should reject invalid event type', () => {
      const invalidEvent = {
        event_type: 'invalid_type',
        title: 'Test',
        start_time: null,
        end_time: null,
        condition: { type: null, value: null },
        confidence: 0.5,
      };

      const result = ExtractedEventSchema.safeParse(invalidEvent);
      expect(result.success).toBe(false);
    });

    it('should reject confidence out of range', () => {
      const invalidEvent = {
        event_type: 'new_event',
        title: 'Test',
        start_time: null,
        end_time: null,
        condition: { type: null, value: null },
        confidence: 1.5,
      };

      const result = ExtractedEventSchema.safeParse(invalidEvent);
      expect(result.success).toBe(false);
    });
  });

  describe('StoredMessageSchema', () => {
    it('should validate valid stored message', () => {
      const validMessage = {
        id: 'msg123',
        chat_id: 'chat456',
        sender: 'John Doe',
        content: 'Hello world',
        timestamp: 1703116800,
        processed: false,
        created_at: '2024-12-21T00:00:00.000Z',
      };

      const result = StoredMessageSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should reject missing required fields', () => {
      const invalidMessage = {
        id: 'msg123',
        // missing chat_id, sender, content, etc.
      };

      const result = StoredMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('StoredEventSchema', () => {
    it('should validate valid stored event', () => {
      const validEvent = {
        id: 'evt123',
        title: 'Meeting',
        start_time: '2024-12-20T14:00:00.000Z',
        end_time: '2024-12-20T15:00:00.000Z',
        condition_type: null,
        condition_value: null,
        status: 'active',
        confidence: 0.9,
        source_message_id: 'msg123',
        chat_id: 'chat456',
        user_id: 'user789',
        created_at: '2024-12-21T00:00:00.000Z',
        updated_at: '2024-12-21T00:00:00.000Z',
      };

      const result = StoredEventSchema.safeParse(validEvent);
      expect(result.success).toBe(true);
    });

    it('should reject invalid status', () => {
      const invalidEvent = {
        id: 'evt123',
        title: 'Meeting',
        status: 'invalid_status',
        confidence: 0.9,
        source_message_id: 'msg123',
        chat_id: 'chat456',
        user_id: 'user789',
        created_at: '2024-12-21T00:00:00.000Z',
        updated_at: '2024-12-21T00:00:00.000Z',
      };

      const result = StoredEventSchema.safeParse(invalidEvent);
      expect(result.success).toBe(false);
    });
  });

  describe('ContainerCommandSchema', () => {
    it('should validate valid container command', () => {
      const validCommand = {
        type: 'SEND_NOTIFICATION',
        payload: { title: 'Test', body: 'Hello' },
        userId: 'user123',
        containerId: 'container456',
        timestamp: '2024-12-21T00:00:00.000Z',
        correlationId: 'corr789',
      };

      const result = ContainerCommandSchema.safeParse(validCommand);
      expect(result.success).toBe(true);
    });

    it('should reject invalid command type', () => {
      const invalidCommand = {
        type: 'INVALID_COMMAND',
        payload: {},
        userId: 'user123',
        containerId: 'container456',
        timestamp: '2024-12-21T00:00:00.000Z',
        correlationId: 'corr789',
      };

      const result = ContainerCommandSchema.safeParse(invalidCommand);
      expect(result.success).toBe(false);
    });
  });

  describe('NotificationPayloadSchema', () => {
    it('should validate minimal notification', () => {
      const validNotification = {
        type: 'reminder',
        title: 'Reminder',
        body: 'You have an upcoming event',
      };

      const result = NotificationPayloadSchema.safeParse(validNotification);
      expect(result.success).toBe(true);
    });

    it('should validate full notification with all fields', () => {
      const fullNotification = {
        type: 'reminder',
        event_id: 'evt123',
        title: 'Event Reminder',
        body: 'Your meeting starts in 15 minutes',
        icon: '/icon.png',
        badge: '/badge.png',
        data: { extra: 'data' },
        actions: [
          { action: 'snooze', title: 'Snooze' },
          { action: 'dismiss', title: 'Dismiss' },
        ],
      };

      const result = NotificationPayloadSchema.safeParse(fullNotification);
      expect(result.success).toBe(true);
    });
  });

  describe('PushSubscriptionSchema', () => {
    it('should validate valid push subscription', () => {
      const validSubscription = {
        endpoint: 'https://push.example.com/send/abc123',
        keys: {
          p256dh: 'BNcRdreALRFXTkOO...',
          auth: 'tBHItJI5svbpez...',
        },
      };

      const result = PushSubscriptionSchema.safeParse(validSubscription);
      expect(result.success).toBe(true);
    });

    it('should reject invalid endpoint URL', () => {
      const invalidSubscription = {
        endpoint: 'not-a-valid-url',
        keys: {
          p256dh: 'abc',
          auth: 'def',
        },
      };

      const result = PushSubscriptionSchema.safeParse(invalidSubscription);
      expect(result.success).toBe(false);
    });
  });
});
