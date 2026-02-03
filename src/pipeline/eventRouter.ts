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
  getRecentEventsByChat,
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

// Keywords that indicate a time update/reschedule
const RESCHEDULE_KEYWORDS = [
  'postponed', 'postpone', 'rescheduled', 'reschedule', 'rescheduling',
  'moved to', 'changed to', 'shifted to', 'pushed to', 'delayed to',
  'now at', 'updated to', 'new time', 'time changed',
  'preponed', 'advanced to', 'earlier now',
  // Hindi
  'badal gaya', 'badal gya', 'change ho gaya', 'ab', 'ho gaya',
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

  // =====================================
  // Smart Update Detection
  // If LLM says "new_event" but message looks like a time-only update
  // and there's a recent event in the same chat, treat as update
  // =====================================
  if (extractedEvent.event_type === 'new_event') {
    const shouldBeUpdate = await detectImplicitUpdate(extractedEvent, sourceMessage);
    if (shouldBeUpdate) {
      logger.info('Detected implicit update (time-only message with recent event in chat)', {
        messageContent: sourceMessage.content,
        extractedTitle: extractedEvent.title,
      });
      return handleUpdateEvent(extractedEvent, sourceMessage);
    }
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
 * Detects if a "new_event" should actually be treated as an update
 * 
 * Heuristics:
 * 1. Message is very short (likely just a time update)
 * 2. Title looks like it's just a time expression (not a real event title)
 * 3. There's a recent event in the same chat
 * 4. Content contains time-only patterns
 */
async function detectImplicitUpdate(
  extracted: ExtractedEvent,
  sourceMessage: StoredMessage
): Promise<boolean> {
  const content = sourceMessage.content.toLowerCase().trim();
  
  // Short message with time - likely an update
  const isShortMessage = content.length < 50;
  
  // Check if CONTENT looks like just a time expression (regardless of title)
  const timeOnlyContentPatterns = [
    /^now\s+(at\s+)?\d/i,                    // "now at 5 PM", "now 5pm"
    /^now\s+(today|tomorrow)/i,              // "now today at..."
    /^(today|tomorrow)\s+(at\s+)?\d/i,       // "today at 5pm", "tomorrow 3pm"
    /^at\s+\d/i,                             // "at 5 PM"
    /^\d{1,2}[\s:]*(am|pm)/i,                // "5pm", "5 pm", "5:30pm"
    /^(ab|abhi)\s+\d/i,                      // Hindi: "ab 5 baje"
    /^(let'?s\s+)?make\s+it\s+\d/i,          // "let's make it 5pm"
    /^(changed?|shift(ed)?)\s+to\s+\d/i,     // "changed to 5pm"
    /^actually\s+\d/i,                       // "actually 5pm"
    /^instead\s+\d/i,                        // "instead 5pm"
  ];
  const contentLooksLikeTime = timeOnlyContentPatterns.some(p => p.test(content));
  
  // Check if title is just a time expression (not a real event name)
  const timeOnlyTitlePatterns = [
    /^now\s+(today|tomorrow|at)/i,
    /^(today|tomorrow)\s+at/i,
    /^at\s+\d/i,
    /^\d{1,2}[\s:]*(am|pm)/i,
    /^(now|ab)\s+\d/i,
    /^now\s+at\s+\d/i,                       // "Now at 5 pm"
  ];
  const titleLooksLikeTime = extracted.title && 
    timeOnlyTitlePatterns.some(p => p.test(extracted.title!));
  
  // Check for recent events in the same chat
  const recentEvents = getRecentEventsByChat(sourceMessage.chat_id, 5);
  const hasRecentEvent = recentEvents.length > 0;
  
  // Check if recent event was created in last 30 minutes
  const veryRecentEvent = recentEvents.find(e => {
    const createdAt = new Date(e.created_at).getTime();
    const thirtyMinsAgo = Date.now() - (30 * 60 * 1000);
    return createdAt > thirtyMinsAgo;
  });
  
  logger.debug('Implicit update detection', {
    isShortMessage,
    contentLooksLikeTime,
    titleLooksLikeTime,
    hasRecentEvent,
    hasVeryRecentEvent: !!veryRecentEvent,
    content,
    title: extracted.title,
  });
  
  // If content looks like just a time AND there's a very recent event, it's an update
  if (contentLooksLikeTime && veryRecentEvent) {
    return true;
  }
  
  // If title looks like just a time AND there's a very recent event, it's an update
  if (titleLooksLikeTime && veryRecentEvent) {
    return true;
  }
  
  // If it's a short message, content looks like time, and has recent events
  if (isShortMessage && contentLooksLikeTime && hasRecentEvent) {
    return true;
  }
  
  // If it's a short message, title looks like time, and has recent events
  if (isShortMessage && titleLooksLikeTime && hasRecentEvent) {
    return true;
  }
  
  return false;
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
    // Proactive trigger fields
    context_tags: extracted.context_tags || [],
    location: extracted.location || null,
    trigger_keywords: extracted.trigger_keywords || [],
    proactive_triggered: false,
    proactive_trigger_count: 0,
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
 * 
 * UPDATE STRATEGY:
 * 1. First, check recent events in the SAME CHAT (most reliable)
 * 2. If no match, use FAISS similarity search as fallback
 * 3. Match by title similarity and/or time proximity
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

  logger.info('Handling update event', {
    chatId: sourceMessage.chat_id,
    extractedTitle: extracted.title,
    isCancelRequest,
    isCompleteRequest,
  });

  // =====================================
  // STRATEGY 1: Find recent events in SAME CHAT
  // =====================================
  const recentChatEvents = getRecentEventsByChat(sourceMessage.chat_id, 10);
  
  let candidateEvent: StoredEvent | null = null;
  let matchSource = 'none';

  if (recentChatEvents.length > 0) {
    logger.debug('Found recent events in same chat', {
      count: recentChatEvents.length,
      eventIds: recentChatEvents.map(e => e.id),
    });

    // Try to find best match by title similarity or recency
    if (extracted.title) {
      // If we have a title from extraction, find best title match
      const titleLower = extracted.title.toLowerCase();
      
      for (const event of recentChatEvents) {
        const eventTitleLower = (event.title || '').toLowerCase();
        
        // Check for title overlap (words in common)
        const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);
        const eventWords = eventTitleLower.split(/\s+/).filter(w => w.length > 2);
        const commonWords = titleWords.filter(w => eventWords.includes(w) || eventTitleLower.includes(w));
        
        if (commonWords.length > 0 || titleLower.includes(eventTitleLower) || eventTitleLower.includes(titleLower)) {
          candidateEvent = event;
          matchSource = 'title_match';
          logger.info('Found event by title match in same chat', {
            eventId: event.id,
            eventTitle: event.title,
            extractedTitle: extracted.title,
            commonWords,
          });
          break;
        }
      }
    }
    
    // If no title match, use the most recent event in the chat
    if (!candidateEvent && recentChatEvents.length > 0) {
      candidateEvent = recentChatEvents[0];
      matchSource = 'most_recent';
      logger.info('Using most recent event in same chat', {
        eventId: candidateEvent.id,
        eventTitle: candidateEvent.title,
        createdAt: candidateEvent.created_at,
      });
    }
  }

  // =====================================
  // STRATEGY 2: FAISS fallback if no same-chat match
  // =====================================
  if (!candidateEvent) {
    try {
      const searchText = `${extracted.title || ''} ${sourceMessage.content}`;
      const embedding = await generateEmbedding(searchText);
      const searchResults = await vectorStore.search(embedding, 5);

      if (searchResults.length > 0) {
        // Prefer events from the same chat
        for (const result of searchResults) {
          const event = await db.getEvent(result.eventId);
          if (event && event.chat_id === sourceMessage.chat_id) {
            candidateEvent = event;
            matchSource = 'faiss_same_chat';
            logger.info('Found event via FAISS (same chat)', {
              eventId: event.id,
              similarity: result.similarity,
            });
            break;
          }
        }
        
        // If no same-chat match, use best FAISS result
        if (!candidateEvent && searchResults[0].similarity > 0.7) {
          candidateEvent = await db.getEvent(searchResults[0].eventId);
          matchSource = 'faiss_global';
          logger.info('Found event via FAISS (global)', {
            eventId: candidateEvent?.id,
            similarity: searchResults[0].similarity,
          });
        }
      }
    } catch (error) {
      logger.warn('FAISS search failed during update', { error });
    }
  }

  // =====================================
  // No candidate found - create new event
  // =====================================
  if (!candidateEvent) {
    logger.warn('No candidate event found for update, creating new', {
      chatId: sourceMessage.chat_id,
      extractedTitle: extracted.title,
    });
    return handleNewEvent(extracted, sourceMessage);
  }

  logger.info('Updating event', {
    eventId: candidateEvent.id,
    eventTitle: candidateEvent.title,
    matchSource,
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

  // Check if this is a reschedule/time update
  const isReschedule = RESCHEDULE_KEYWORDS.some(k => messageContent.includes(k));
  
  // Standard update - modify event details
  let updatedFields: string[] = [];
  
  if (extracted.title && extracted.title !== candidateEvent.title) {
    updates.title = extracted.title;
    updatedFields.push(`title: "${candidateEvent.title}" → "${extracted.title}"`);
  }
  if (extracted.start_time) {
    updates.start_time = extracted.start_time;
    updatedFields.push(`time: ${candidateEvent.start_time || 'none'} → ${extracted.start_time}`);
  }
  if (extracted.end_time) {
    updates.end_time = extracted.end_time;
  }
  if (extracted.condition.type) {
    updates.condition_type = extracted.condition.type;
    updates.condition_value = extracted.condition.value;
    updatedFields.push(`condition: ${extracted.condition.type}`);
  }

  logger.info('Applying event updates', {
    eventId: candidateEvent.id,
    isReschedule,
    updatedFields,
  });

  await db.updateEvent(candidateEvent.id, updates);

  // Get the updated event
  const updatedEvent = await db.getEvent(candidateEvent.id);
  
  // Send notification for the update
  if (updatedEvent && updatedFields.length > 0) {
    const timeStr = updatedEvent.start_time 
      ? new Date(updatedEvent.start_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      : 'TBD';
    
    await sendNotification({
      type: 'update',
      event_id: updatedEvent.id,
      title: 'Event Updated',
      body: `"${updatedEvent.title}" updated to ${timeStr}`,
      data: {
        updatedFields,
        previousTime: candidateEvent.start_time,
        newTime: updatedEvent.start_time,
      },
    });
    
    logger.info('Sent update notification', {
      eventId: updatedEvent.id,
      title: updatedEvent.title,
      newTime: updatedEvent.start_time,
    });
  }

  // Recheck conflicts
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
