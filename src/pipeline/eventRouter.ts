/**
 * Event Router Module
 * 
 * Routes extracted events to appropriate handlers based on event type.
 * Handles database operations, vector storage, and scheduling.
 * 
 * DEDUPLICATION:
 * - Uses FAISS vector similarity to detect if a similar event already exists
 * - Prevents duplicate events from same message (source_message_id check)
 * - Updates existing events if high similarity match found
 */

import { v4 as uuidv4 } from 'uuid';
import { 
  ExtractedEvent, 
  StoredEvent, 
  StoredMessage, 
  EventStatus,
  ConflictResult 
} from '../types/index.js';
import { 
  getDatabase, 
  eventExistsForMessage, 
  getEventBySourceMessage,
  storeEventWithExtraction,
} from '../database/sqlite.js';
import { getVectorStore, generateEmbedding } from '../vector/faiss.js';
import { scheduleReminder } from '../scheduler/index.js';
import { sendNotification } from '../notifications/index.js';
import logger from '../utils/logger.js';

// Similarity threshold for considering events as duplicates
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

// Keywords that indicate a cancel request
const CANCEL_KEYWORDS = [
  'cancel', 'cancelled', 'canceled', 'cancelling', 'canceling',
  'drop', 'dropped', 'skip', 'skipping',
  'not happening', 'won\'t happen', 'wont happen',
  'call off', 'called off',
  'abort', 'aborted',
  'forget about', 'never mind', 'nevermind',
];

// Keywords that indicate a complete request
const COMPLETE_KEYWORDS = [
  'done', 'completed', 'finished', 'complete',
  'happened', 'over', 'ended',
  'attended', 'went to',
  'mission accomplished', 'all done',
];

/**
 * Options for routing an event
 */
export interface RouteEventOptions {
  needsConfirmation?: boolean;  // If true, event will be created with pending_confirmation status
}

/**
 * Routes an extracted event to the appropriate handler
 */
export async function routeEvent(
  extractedEvent: ExtractedEvent,
  sourceMessage: StoredMessage,
  options: RouteEventOptions = {}
): Promise<StoredEvent | null> {
  const { needsConfirmation = false } = options;
  logger.info('Routing event', {
    eventType: extractedEvent.event_type,
    messageId: sourceMessage.id,
  });

  // First check: Event already exists for this message ID (exact deduplication)
  if (eventExistsForMessage(sourceMessage.id)) {
    const existingEvent = getEventBySourceMessage(sourceMessage.id);
    logger.info('Event already exists for source message, returning existing', {
      messageId: sourceMessage.id,
      existingEventId: existingEvent?.id,
    });
    return existingEvent;
  }

  switch (extractedEvent.event_type) {
    case 'new_event':
      return handleNewEvent(extractedEvent, sourceMessage, { needsConfirmation });
    
    case 'update_event':
      return handleUpdateEvent(extractedEvent, sourceMessage);
    
    case 'signal_event':
      return handleSignalEvent(extractedEvent, sourceMessage);
    
    case 'irrelevant':
    default:
      logger.debug('Event marked as irrelevant, dropping');
      return null;
  }
}

/**
 * Handles a new event with FAISS-based deduplication
 */
async function handleNewEvent(
  extracted: ExtractedEvent,
  sourceMessage: StoredMessage,
  options: { needsConfirmation?: boolean } = {}
): Promise<StoredEvent> {
  const { needsConfirmation = false } = options;
  const db = getDatabase();
  const vectorStore = getVectorStore();

  // =====================================
  // FAISS Deduplication Check
  // =====================================
  const searchText = `${extracted.title || ''} ${sourceMessage.content}`;
  
  try {
    const embedding = await generateEmbedding(searchText);
    const searchResults = await vectorStore.search(embedding, 3);
    
    // Check if there's a very similar existing event
    if (searchResults.length > 0) {
      const topMatch = searchResults[0];
      
      if (topMatch.similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
        const existingEvent = await db.getEvent(topMatch.eventId);
        
        if (existingEvent) {
          logger.info('Duplicate event detected via FAISS', {
            newTitle: extracted.title,
            existingTitle: existingEvent.title,
            similarity: topMatch.similarity,
            existingEventId: existingEvent.id,
          });
          
          // If times are similar too, skip creating duplicate
          if (isSimilarTime(extracted.start_time, existingEvent.start_time)) {
            logger.info('Skipping duplicate event creation', {
              existingEventId: existingEvent.id,
            });
            return existingEvent;
          }
        }
      }
    }
  } catch (error) {
    logger.warn('FAISS deduplication check failed, continuing with event creation', { error });
  }

  // =====================================
  // Create New Event
  // =====================================
  
  // Determine event status
  let status: EventStatus = 'soft';
  if (needsConfirmation) {
    // Event needs user confirmation (task without time or contextual trigger)
    status = 'pending_confirmation';
  } else if (extracted.start_time) {
    status = 'active';
  } else if (extracted.condition.type) {
    status = 'pending';
  }

  // Create stored event
  const event: StoredEvent = {
    id: uuidv4(),
    title: extracted.title,
    start_time: extracted.start_time,
    end_time: extracted.end_time,
    condition_type: extracted.condition.type,
    condition_value: extracted.condition.value,
    status,
    confidence: extracted.confidence,
    source_message_id: sourceMessage.id,
    chat_id: sourceMessage.chat_id,
    contact_name: sourceMessage.sender || null,  // Who sent the message
    participants: extracted.participants || [],   // People involved in event
    created_by: extracted.created_by || sourceMessage.sender || null,  // Who created the event
    user_id: 'default',  // Single-user mode
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Store event with raw extraction data
  storeEventWithExtraction(event, {
    event_type: extracted.event_type,
    title: extracted.title,
    start_time: extracted.start_time,
    end_time: extracted.end_time,
    condition: extracted.condition,
    participants: extracted.participants,
    created_by: extracted.created_by,
    confidence: extracted.confidence,
    source_content: sourceMessage.content,
    source_sender: sourceMessage.sender,
  });
  
  logger.info('Event stored', { eventId: event.id, status });

  // Generate and store embedding for future deduplication
  try {
    const embedding = await generateEmbedding(
      `${event.title || ''} ${sourceMessage.content}`
    );
    await vectorStore.addVector(event.id, embedding);
    logger.debug('Event embedding stored', { eventId: event.id });
  } catch (error) {
    logger.error('Failed to store embedding', { error, eventId: event.id });
  }

  // Check for conflicts if event has time
  if (event.start_time && event.end_time) {
    const conflict = await checkConflicts(event);
    if (conflict.hasConflict) {
      logger.warn('Event conflict detected', {
        eventId: event.id,
        conflictingIds: conflict.conflictingEvents.map(e => e.id),
      });
      await sendNotification({
        type: 'conflict',
        event_id: event.id,
        title: 'Schedule Conflict',
        body: `"${event.title}" conflicts with existing events`,
        data: { conflictingEvents: conflict.conflictingEvents.map(e => e.id) },
      });
    }
  }

  // Send notification for pending_confirmation events with accept/decline actions
  if (status === 'pending_confirmation') {
    const conditionText = extracted.condition.value 
      ? ` (${extracted.condition.value})` 
      : '';
    
    await sendNotification({
      type: 'reminder',
      event_id: event.id,
      title: 'New Reminder',
      body: `${event.title}${conditionText}`,
      icon: '/icons/reminder-192.png',
      data: { 
        eventId: event.id,
        status: 'pending_confirmation',
        condition: extracted.condition,
        sender: sourceMessage.sender,
        requiresConfirmation: true,
      },
      actions: [
        { action: 'accept', title: 'Accept' },
        { action: 'decline', title: 'Decline' },
      ],
    });
    
    logger.info('Sent pending confirmation notification', {
      eventId: event.id,
      title: event.title,
    });
  }

  // Schedule reminder if has start time
  if (event.start_time && status === 'active') {
    await scheduleReminder(event);
    logger.debug('Reminder scheduled', { eventId: event.id });
  }

  return event;
}

/**
 * Check if two times are similar (within 1 hour)
 */
function isSimilarTime(time1: string | null, time2: string | null): boolean {
  if (!time1 || !time2) return false;
  
  try {
    const d1 = new Date(time1);
    const d2 = new Date(time2);
    const diffMs = Math.abs(d1.getTime() - d2.getTime());
    const oneHourMs = 60 * 60 * 1000;
    return diffMs <= oneHourMs;
  } catch {
    return false;
  }
}

/**
 * Handles an update to an existing event
 * Also handles cancel/complete requests if detected in source message
 */
async function handleUpdateEvent(
  extracted: ExtractedEvent,
  sourceMessage: StoredMessage
): Promise<StoredEvent | null> {
  const db = getDatabase();
  const vectorStore = getVectorStore();

  // Detect if this is a cancel/complete request from the message content
  const messageContent = sourceMessage.content.toLowerCase();
  const isCancelRequest = CANCEL_KEYWORDS.some(k => messageContent.includes(k));
  const isCompleteRequest = COMPLETE_KEYWORDS.some(k => messageContent.includes(k));

  // Find candidate event using FAISS similarity search
  const searchText = `${extracted.title || ''} ${sourceMessage.content}`;
  const embedding = await generateEmbedding(searchText);
  const searchResults = await vectorStore.search(embedding, 5);

  if (searchResults.length === 0) {
    logger.warn('No candidate event found for update, creating new');
    return handleNewEvent(extracted, sourceMessage);
  }

  // Get the most similar event
  const candidateId = searchResults[0].eventId;
  const candidateEvent = await db.getEvent(candidateId);

  if (!candidateEvent) {
    logger.warn('Candidate event not found in database', { candidateId });
    return handleNewEvent(extracted, sourceMessage);
  }

  logger.info('Updating event', {
    eventId: candidateEvent.id,
    similarity: searchResults[0].similarity,
    isCancelRequest,
    isCompleteRequest,
  });

  // Apply updates
  const updates: Partial<StoredEvent> = {
    updated_at: new Date().toISOString(),
  };

  // Handle cancel request - mark event as cancelled
  if (isCancelRequest) {
    updates.status = 'cancelled';
    logger.info('Cancelling event', { eventId: candidateEvent.id });
    
    await db.updateEvent(candidateEvent.id, updates);
    const cancelledEvent = await db.getEvent(candidateEvent.id);
    
    if (cancelledEvent) {
      await sendNotification({
        type: 'cancelled',
        event_id: cancelledEvent.id,
        title: 'Event Cancelled',
        body: `"${cancelledEvent.title}" has been cancelled`,
      });
    }
    
    return cancelledEvent;
  }

  // Handle complete request - mark event as completed
  if (isCompleteRequest) {
    updates.status = 'completed';
    logger.info('Completing event', { eventId: candidateEvent.id });
    
    await db.updateEvent(candidateEvent.id, updates);
    const completedEvent = await db.getEvent(candidateEvent.id);
    
    return completedEvent;
  }

  // Standard update - modify event details
  if (extracted.title) {
    updates.title = extracted.title;
  }
  if (extracted.start_time) {
    updates.start_time = extracted.start_time;
  }
  if (extracted.end_time) {
    updates.end_time = extracted.end_time;
  }
  if (extracted.condition.type) {
    updates.condition_type = extracted.condition.type;
    updates.condition_value = extracted.condition.value;
  }

  await db.updateEvent(candidateEvent.id, updates);

  // Recheck conflicts
  const updatedEvent = await db.getEvent(candidateEvent.id);
  if (updatedEvent && updatedEvent.start_time && updatedEvent.end_time) {
    const conflict = await checkConflicts(updatedEvent);
    if (conflict.hasConflict) {
      await sendNotification({
        type: 'conflict',
        event_id: updatedEvent.id,
        title: 'Schedule Conflict',
        body: `Updated event "${updatedEvent.title}" has conflicts`,
      });
    }
  }

  // Reschedule reminder
  if (updatedEvent && updatedEvent.start_time) {
    await scheduleReminder(updatedEvent);
  }

  return updatedEvent;
}

/**
 * Handles a signal event (trigger for pending events)
 */
async function handleSignalEvent(
  extracted: ExtractedEvent,
  sourceMessage: StoredMessage
): Promise<StoredEvent | null> {
  const db = getDatabase();
  const vectorStore = getVectorStore();

  // Search for pending events that might match this signal
  const searchText = `${extracted.condition.value || ''} ${sourceMessage.content}`;
  const embedding = await generateEmbedding(searchText);
  const searchResults = await vectorStore.search(embedding, 10);

  // Get pending events
  const pendingEvents = await db.getPendingEvents();
  
  // Find matching pending event
  const matchingEvent = pendingEvents.find(event => {
    // Check if this event matches any search result
    return searchResults.some(r => r.eventId === event.id && r.similarity > 0.7);
  });

  if (!matchingEvent) {
    logger.debug('No pending event matches signal');
    return null;
  }

  logger.info('Activating pending event', { eventId: matchingEvent.id });

  // Activate the event
  const now = new Date();
  const updates: Partial<StoredEvent> = {
    status: 'active',
    start_time: now.toISOString(),
    updated_at: now.toISOString(),
  };

  await db.updateEvent(matchingEvent.id, updates);
  const activatedEvent = await db.getEvent(matchingEvent.id);

  if (activatedEvent) {
    // Schedule reminder
    await scheduleReminder(activatedEvent);
    
    // Send notification
    await sendNotification({
      type: 'reminder',
      event_id: activatedEvent.id,
      title: 'Event Activated',
      body: `"${activatedEvent.title}" has been triggered`,
    });
  }

  return activatedEvent;
}

/**
 * Checks for scheduling conflicts
 */
async function checkConflicts(event: StoredEvent): Promise<ConflictResult> {
  if (!event.start_time || !event.end_time) {
    return { hasConflict: false, conflictingEvents: [] };
  }

  const db = getDatabase();
  const conflictingEvents = await db.findConflicts(
    event.start_time,
    event.end_time,
    event.id
  );

  return {
    hasConflict: conflictingEvents.length > 0,
    conflictingEvents,
  };
}

export default { routeEvent };
