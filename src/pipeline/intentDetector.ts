/**
 * Intent Detector Module
 * 
 * Detects user intent (cancel, reschedule, update) from messages
 * and uses FAISS to find related existing events.
 * 
 * FLOW:
 * 1. Detect intent keywords in message (cancel, reschedule, update, etc.)
 * 2. If intent detected, search FAISS for similar existing events
 * 3. Return matched events as context for the extractor/router
 */

import { StoredEvent, StoredMessage } from '../types/index.js';
import { getVectorStore, generateEmbedding } from '../vector/faiss.js';
import { getDatabase } from '../database/sqlite.js';
import logger from '../utils/logger.js';

export type IntentType = 'cancel' | 'reschedule' | 'update' | 'complete' | 'none';

export interface IntentResult {
  intent: IntentType;
  confidence: number;
  keywords: string[];
  matchedEvents: StoredEvent[];
}

// Intent keywords grouped by type
const INTENT_KEYWORDS: Record<IntentType, string[]> = {
  cancel: [
    'cancel', 'cancelled', 'canceled', 'cancelling', 'canceling',
    'drop', 'dropped', 'skip', 'skipping',
    'not happening', 'won\'t happen', 'wont happen',
    'call off', 'called off',
    'abort', 'aborted',
    'forget about', 'never mind', 'nevermind',
  ],
  reschedule: [
    'reschedule', 'rescheduled', 'rescheduling',
    'postpone', 'postponed', 'postponing',
    'move to', 'moved to', 'moving to',
    'shift to', 'shifted to', 'shifting to',
    'push to', 'pushed to', 'pushing to',
    'delay', 'delayed', 'delaying',
    'change the time', 'change time', 'new time',
    'change the date', 'change date', 'new date',
  ],
  update: [
    'update', 'updated', 'updating',
    'change', 'changed', 'changing',
    'modify', 'modified', 'modifying',
    'edit', 'edited', 'editing',
    'correction', 'correct',
    'actually', 'instead',
    'new location', 'new venue', 'new place',
    'different location', 'different venue', 'different place',
  ],
  complete: [
    'done', 'completed', 'finished', 'complete',
    'happened', 'over', 'ended',
    'attended', 'went to',
    'mission accomplished', 'all done',
  ],
  none: [],
};

// Minimum similarity threshold for FAISS matches
const SIMILARITY_THRESHOLD = 0.5;
const MAX_MATCHES = 5;

/**
 * Detects intent and finds related events using FAISS
 */
export async function detectIntent(message: StoredMessage): Promise<IntentResult> {
  const content = message.content.toLowerCase().trim();
  
  logger.debug('Detecting intent', { 
    messageId: message.id, 
    contentLength: content.length 
  });

  // Step 1: Detect intent from keywords
  let detectedIntent: IntentType = 'none';
  let intentConfidence = 0;
  const foundKeywords: string[] = [];

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS) as [IntentType, string[]][]) {
    if (intent === 'none') continue;
    
    for (const keyword of keywords) {
      if (content.includes(keyword)) {
        foundKeywords.push(keyword);
        
        // First match determines intent, but we collect all matching keywords
        if (detectedIntent === 'none') {
          detectedIntent = intent;
          intentConfidence = 0.7; // Base confidence
        }
        
        // Increase confidence for multiple keyword matches
        if (detectedIntent === intent) {
          intentConfidence = Math.min(0.95, intentConfidence + 0.1);
        }
      }
    }
  }

  // If no intent detected, return early
  if (detectedIntent === 'none') {
    logger.debug('No intent detected', { messageId: message.id });
    return {
      intent: 'none',
      confidence: 0,
      keywords: [],
      matchedEvents: [],
    };
  }

  logger.info('Intent detected', {
    messageId: message.id,
    intent: detectedIntent,
    confidence: intentConfidence,
    keywords: foundKeywords,
  });

  // Step 2: Use FAISS to find related events
  const matchedEvents = await findRelatedEvents(message, content);

  return {
    intent: detectedIntent,
    confidence: intentConfidence,
    keywords: foundKeywords,
    matchedEvents,
  };
}

/**
 * Finds related events using FAISS vector similarity
 */
async function findRelatedEvents(
  message: StoredMessage,
  content: string
): Promise<StoredEvent[]> {
  const vectorStore = getVectorStore();
  const db = getDatabase();

  try {
    // Generate embedding for the message content
    const embedding = await generateEmbedding(content);
    
    // Search FAISS for similar events
    const searchResults = await vectorStore.search(embedding, MAX_MATCHES);
    
    if (searchResults.length === 0) {
      logger.debug('No FAISS matches found', { messageId: message.id });
      return [];
    }

    // Fetch event details for matches above threshold
    const matchedEvents: StoredEvent[] = [];
    
    for (const result of searchResults) {
      if (result.similarity < SIMILARITY_THRESHOLD) {
        continue;
      }

      const event = await db.getEvent(result.eventId);
      
      if (event && event.status !== 'cancelled' && event.status !== 'completed') {
        matchedEvents.push(event);
        
        logger.debug('FAISS match found', {
          messageId: message.id,
          eventId: event.id,
          eventTitle: event.title,
          similarity: result.similarity,
        });
      }
    }

    // Also check for events from the same contact
    if (message.sender) {
      const contactEvents = await db.getActiveEventsByContact(message.sender);
      
      // Add contact events that aren't already in the list
      for (const event of contactEvents) {
        if (!matchedEvents.find(e => e.id === event.id)) {
          matchedEvents.push(event);
        }
      }
    }

    logger.info('Related events found', {
      messageId: message.id,
      matchCount: matchedEvents.length,
      eventIds: matchedEvents.map(e => e.id),
    });

    return matchedEvents.slice(0, MAX_MATCHES);
  } catch (error) {
    logger.error('Failed to find related events', { error, messageId: message.id });
    return [];
  }
}

/**
 * Formats matched events as context for the LLM
 */
export function formatMatchedEventsContext(events: StoredEvent[]): string {
  if (events.length === 0) {
    return '';
  }

  const lines = [
    '\n--- EXISTING EVENTS (for reference) ---',
    'The following events are currently scheduled and may be related to this message:',
  ];

  for (const event of events) {
    lines.push(`\n[Event ID: ${event.id}]`);
    lines.push(`- Title: ${event.title || 'Untitled'}`);
    
    if (event.start_time) {
      lines.push(`- When: ${event.start_time}`);
    }
    
    if (event.contact_name) {
      lines.push(`- Contact: ${event.contact_name}`);
    }
    
    if (event.participants && event.participants.length > 0) {
      lines.push(`- Participants: ${event.participants.join(', ')}`);
    }
    
    lines.push(`- Status: ${event.status}`);
  }

  lines.push('\n--- END EXISTING EVENTS ---\n');

  return lines.join('\n');
}

export default { detectIntent, formatMatchedEventsContext };
