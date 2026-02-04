/**
 * Shared Types for Multi-Container Architecture
 * 
 * Types shared between user containers and orchestrator
 */

import { z } from 'zod';

// ============================================
// Event Types (ENUM)
// ============================================
export const EventTypeSchema = z.enum(['new_event', 'update_event', 'signal_event', 'irrelevant']);
export type EventType = z.infer<typeof EventTypeSchema>;

export const ConditionTypeSchema = z.enum(['location', 'time', 'dependency']).nullable();
export type ConditionType = z.infer<typeof ConditionTypeSchema>;

export const EventStatusSchema = z.enum(['active', 'pending', 'completed', 'cancelled', 'declined', 'snoozed']);
export type EventStatus = z.infer<typeof EventStatusSchema>;

// ============================================
// Core Schemas with Zod Validation
// ============================================

export const EventConditionSchema = z.object({
  type: ConditionTypeSchema,
  value: z.string().nullable(),
});
export type EventCondition = z.infer<typeof EventConditionSchema>;

export const ExtractedEventSchema = z.object({
  event_type: EventTypeSchema,
  title: z.string().nullable(),
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
  condition: EventConditionSchema,
  participants: z.array(z.string()).optional().default([]),  // Names of people involved in the event
  created_by: z.string().nullable().optional(),              // Who sent the message
  confidence: z.number().min(0).max(1),
  // Proactive trigger fields
  context_tags: z.array(z.string()).optional().default([]),  // Keywords for proactive matching: ["goa", "shopping"]
  location: z.string().nullable().optional(),                 // Primary location: "goa", "mumbai", "office"
  trigger_keywords: z.array(z.string()).optional().default([]), // Keywords that should trigger reminder
});
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

export const StoredMessageSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  sender: z.string(),
  sender_name: z.string().optional(),
  content: z.string(),
  timestamp: z.number(),
  timestamp_ist: z.string().optional(),
  is_from_me: z.boolean().optional(),
  message_type: z.string().optional(),
  processed: z.boolean(),
  created_at: z.string(),
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

export const StoredEventSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  event_type: z.string().nullable().optional(),
  start_time: z.string().nullable(),
  start_time_ist: z.string().nullable().optional(),  // IST formatted time
  end_time: z.string().nullable(),
  end_time_ist: z.string().nullable().optional(),    // IST formatted time
  condition_type: ConditionTypeSchema,
  condition_value: z.string().nullable(),
  status: EventStatusSchema,
  confidence: z.number(),
  source_message_id: z.string(),
  source_message_content: z.string().nullable().optional(),  // Original message that triggered event
  chat_id: z.string(),
  contact_name: z.string().nullable().optional(),    // Who sent the message / contact name
  participants: z.array(z.string()).optional().default([]),  // People involved in the event
  created_by: z.string().nullable().optional(),      // Who created/sent the event message
  user_id: z.string().optional().default('default'),  // Optional for single-user mode
  // Proactive trigger fields
  context_tags: z.array(z.string()).optional().default([]),  // Keywords for proactive matching
  location: z.string().nullable().optional(),                 // Primary location
  trigger_keywords: z.array(z.string()).optional().default([]), // Keywords that should trigger reminder
  proactive_triggered: z.boolean().optional().default(false),   // Has proactive reminder been sent?
  proactive_trigger_count: z.number().optional().default(0),    // How many times triggered
  created_at: z.string(),
  updated_at: z.string(),
});
export type StoredEvent = z.infer<typeof StoredEventSchema>;

// ============================================
// Inter-Container Communication
// ============================================

export const ContainerCommandSchema = z.object({
  type: z.enum([
    'NEW_EVENT',
    'UPDATE_EVENT',
    'DELETE_EVENT',
    'SEND_NOTIFICATION',
    'REGISTER_PUSH',
    'SYNC_REQUEST',
    'HEALTH_CHECK',
  ]),
  payload: z.record(z.unknown()),
  userId: z.string(),
  containerId: z.string(),
  timestamp: z.string(),
  correlationId: z.string(),
});
export type ContainerCommand = z.infer<typeof ContainerCommandSchema>;

export const ContainerResponseSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  correlationId: z.string(),
  timestamp: z.string(),
});
export type ContainerResponse = z.infer<typeof ContainerResponseSchema>;

// ============================================
// User & Container Management
// ============================================

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email().optional(),
  phone: z.string(),
  containerId: z.string(),
  containerStatus: z.enum(['running', 'stopped', 'creating', 'error']),
  createdAt: z.string(),
  lastActiveAt: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const ContainerInfoSchema = z.object({
  id: z.string(),
  userId: z.string(),
  status: z.enum(['running', 'stopped', 'creating', 'error']),
  port: z.number(),
  hostname: z.string(),
  createdAt: z.string(),
  lastHealthCheck: z.string().optional(),
});
export type ContainerInfo = z.infer<typeof ContainerInfoSchema>;

// ============================================
// Push Notification Types
// ============================================

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});
export type PushSubscriptionData = z.infer<typeof PushSubscriptionSchema>;

export const NotificationPayloadSchema = z.object({
  type: z.enum(['reminder', 'conflict', 'update', 'cancelled', 'system']),
  event_id: z.string().optional(),
  title: z.string(),
  body: z.string(),
  icon: z.string().optional(),
  badge: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  actions: z.array(z.object({
    action: z.string(),
    title: z.string(),
  })).optional(),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

// ============================================
// API Response Types
// ============================================

export const ApiResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    success: z.boolean(),
    data: dataSchema.optional(),
    error: z.string().optional(),
    meta: z.object({
      timestamp: z.string(),
      requestId: z.string(),
    }).optional(),
  });

export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    timestamp: string;
    requestId: string;
  };
};

// ============================================
// WebSocket Message Types
// ============================================

export const WsMessageSchema = z.object({
  type: z.enum([
    'subscribe',
    'unsubscribe',
    'event_created',
    'event_updated',
    'event_deleted',
    'notification',
    'ping',
    'pong',
    'error',
  ]),
  payload: z.unknown(),
  userId: z.string().optional(),
  timestamp: z.string(),
});
export type WsMessage = z.infer<typeof WsMessageSchema>;

// ============================================
// Classification & Pipeline Types
// ============================================

export const ClassificationResultSchema = z.object({
  event_type: EventTypeSchema,
  confidence: z.number().min(0).max(1),
});
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

export const MessageContextSchema = z.object({
  messages: z.array(StoredMessageSchema),
  compressed: z.boolean(),
  compressedContent: z.string().optional(),
  tokenCount: z.number(),
});
export type MessageContext = z.infer<typeof MessageContextSchema>;

export const HeuristicResultSchema = z.object({
  hasSignal: z.boolean(),
  signals: z.array(z.string()),
  score: z.number(),
});
export type HeuristicResult = z.infer<typeof HeuristicResultSchema>;

export const PipelineStageSchema = z.enum([
  'received',
  'heuristic',
  'extracted',
  'stored',
  'completed',
  'dropped',
  'error',
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PipelineStateSchema = z.object({
  messageId: z.string(),
  stage: PipelineStageSchema,
  startedAt: z.number(),
  completedAt: z.number().optional(),
  error: z.string().optional(),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

// ============================================
// Evolution API Types
// ============================================

export const EvolutionWebhookPayloadSchema = z.object({
  event: z.string(),
  instance: z.string(),
  data: z.object({
    key: z.object({
      remoteJid: z.string(),
      fromMe: z.boolean(),
      id: z.string(),
      participant: z.string().optional(),
    }),
    pushName: z.string().optional(),
    message: z.object({
      conversation: z.string().optional(),
      extendedTextMessage: z.object({
        text: z.string(),
      }).optional(),
    }),
    messageType: z.string(),
    messageTimestamp: z.number(),
  }),
});
export type EvolutionWebhookPayload = z.infer<typeof EvolutionWebhookPayloadSchema>;

// ============================================
// Database Interfaces
// ============================================

export interface IDatabase {
  storeMessage(message: StoredMessage): Promise<void>;
  getMessage(id: string): Promise<StoredMessage | null>;
  getRecentMessages(chatId: string, limit: number): Promise<StoredMessage[]>;
  storeEvent(event: StoredEvent): Promise<void>;
  getEvent(id: string): Promise<StoredEvent | null>;
  updateEvent(id: string, updates: Partial<StoredEvent>): Promise<void>;
  findConflicts(startTime: string, endTime: string, excludeId?: string): Promise<StoredEvent[]>;
  getPendingEvents(): Promise<StoredEvent[]>;
  getActiveEventsByContact(contactName: string): Promise<StoredEvent[]>;
}

export interface IVectorStore {
  addVector(eventId: string, embedding: number[]): Promise<void>;
  search(embedding: number[], k: number): Promise<VectorSearchResult[]>;
  remove(eventId: string): Promise<void>;
}

export const VectorSearchResultSchema = z.object({
  eventId: z.string(),
  similarity: z.number(),
});
export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>;

// ============================================
// Scheduler Types
// ============================================

export const ScheduledReminderSchema = z.object({
  id: z.string(),
  event_id: z.string(),
  user_id: z.string().optional().default('default'),  // Optional for single-user mode
  trigger_time: z.string(),
  sent: z.boolean(),
  created_at: z.string(),
});
export type ScheduledReminder = z.infer<typeof ScheduledReminderSchema>;

// ============================================
// Conflict Detection
// ============================================

export const ConflictResultSchema = z.object({
  hasConflict: z.boolean(),
  conflictingEvents: z.array(StoredEventSchema),
});
export type ConflictResult = z.infer<typeof ConflictResultSchema>;
