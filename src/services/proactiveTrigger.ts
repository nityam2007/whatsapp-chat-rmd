/**
 * Proactive Trigger Service (v0.9.0 Simplified)
 * 
 * Monitors ALL incoming messages and uses intelligent matching to detect
 * when any message relates to pending events/tasks.
 * 
 * MATCHING STRATEGY (v0.9.0 - Simplified 2-Stage):
 * 1. SQL Context Query (fast, cheap) - uses location, keywords, context tags
 * 2. Gemini LLM (smart, expensive) - only for ambiguous cases or validation
 * 
 * REMOVED: FAISS vector similarity (was overkill for proactive matching)
 * ADDED: SQL-based context matching with 3-month hot data window
 * 
 * This is intelligent context understanding, not just keyword matching.
 * 
 * Examples of what it can detect:
 * - "Just reached Goa" → triggers "Get cashew from Goa for Priya"
 * - "Meeting with John went well" → triggers "Ask John about the project"
 * - "Feeling better now" → triggers "Schedule doctor follow-up when feeling better"
 * - "Finally got some free time" → triggers any pending leisure tasks
 * - "The client approved the design" → triggers "Send invoice after approval"
 */

import { StoredMessage, StoredEvent } from '../shared/types.js';
import { 
  getEventsForProactiveTrigger, 
  markEventProactivelyTriggered,
  resetProactiveTrigger as dbResetProactiveTrigger,
  storePipelineLog,
  getEventsByContext,
  ExtensionContextQuery,
  ContextMatchResult,
} from '../database/sqlite.js';
import { sendNotification } from '../notifications/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import OpenAI from 'openai';

// Gemini client
let geminiClient: OpenAI | null = null;

function getGeminiClient(): OpenAI {
  if (!geminiClient) {
    geminiClient = new OpenAI({
      apiKey: config.geminiApiKey,
      baseURL: config.geminiApiUrl,
    });
  }
  return geminiClient;
}

export interface ProactiveMatch {
  event: StoredEvent;
  matchReason: string;
  matchType: 'sql_context' | 'intelligent' | 'keyword';
  confidence: number;
  suggestedAction?: string;
}

// Confidence thresholds (simplified in v0.9.0)
const SQL_HIGH_CONFIDENCE_THRESHOLD = 0.80;  // High enough to trigger directly
const SQL_MEDIUM_CONFIDENCE_THRESHOLD = 0.60; // Worth checking with Gemini

/**
 * Check if an incoming message triggers any pending events
 * Uses SQL context matching first, then Gemini for ambiguous cases
 * 
 * SIMPLIFIED in v0.9.0: Removed FAISS, uses SQL-based matching
 */
export async function checkForProactiveTriggers(
  message: StoredMessage
): Promise<ProactiveMatch[]> {
  logger.info('Proactive trigger check started', { 
    messageId: message.id, 
    content: message.content.slice(0, 50),
    enabled: config.enableProactiveTriggers,
  });

  if (!config.enableProactiveTriggers) {
    logger.debug('Proactive triggers disabled by config');
    return [];
  }

  try {
    // =============================================
    // Stage 1: SQL Context Matching (Fast & Cheap)
    // Uses getEventsByContext() with 3-month hot data window
    // =============================================
    const contextQuery = extractContextFromMessage(message.content);
    const sqlMatches = getEventsByContext(contextQuery);
    
    // Convert to ProactiveMatch format
    const matches: ProactiveMatch[] = sqlMatches.map(m => ({
      event: m.event,
      matchReason: `${m.matchType}: ${m.matchedValue}`,
      matchType: 'sql_context' as const,
      confidence: m.confidence,
      suggestedAction: m.event.title || undefined,
    }));
    
    // Log SQL stage
    storePipelineLog({
      message_id: message.id,
      stage: 'proactive_sql',
      status: matches.length > 0 ? 'matches_found' : 'no_matches',
      data: {
        contextQuery,
        matchCount: matches.length,
        matches: matches.map(m => ({
          eventId: m.event.id,
          eventTitle: m.event.title,
          confidence: m.confidence,
          matchType: m.matchType,
        })),
      },
    });
    
    // High-confidence SQL matches - use directly
    const highConfidence = matches.filter(m => m.confidence >= SQL_HIGH_CONFIDENCE_THRESHOLD);
    
    if (highConfidence.length > 0) {
      logger.info('Using high-confidence SQL matches (skipping Gemini)', {
        messageId: message.id,
        matchCount: highConfidence.length,
      });
      
      for (const match of highConfidence) {
        await sendProactiveReminder(message, match);
      }
      
      return highConfidence;
    }
    
    // =============================================
    // Stage 2: Gemini LLM (Smart but Expensive)
    // Only if SQL found medium-confidence matches OR message looks promising
    // =============================================
    const mediumConfidence = matches.filter(
      m => m.confidence >= SQL_MEDIUM_CONFIDENCE_THRESHOLD && m.confidence < SQL_HIGH_CONFIDENCE_THRESHOLD
    );
    
    const mightBeTrigger = checkForTriggerSignals(message.content);
    const shouldUseGemini = mediumConfidence.length > 0 || 
                           (mightBeTrigger && matches.length === 0);
    
    if (shouldUseGemini && config.geminiApiKey) {
      // Get pending events for Gemini to analyze
      const pendingEvents = mediumConfidence.length > 0
        ? mediumConfidence.map(m => m.event)
        : getEventsForProactiveTrigger(20);
      
      if (pendingEvents.length > 0) {
        const geminiMatches = await intelligentContextMatch(message, pendingEvents);
        
        storePipelineLog({
          message_id: message.id,
          stage: 'proactive_gemini',
          status: geminiMatches.length > 0 ? 'matches_found' : 'no_matches',
          data: {
            eventsChecked: pendingEvents.length,
            geminiMatchCount: geminiMatches.length,
            matches: geminiMatches.map(m => ({
              eventId: m.event.id,
              eventTitle: m.event.title,
              confidence: m.confidence,
              reason: m.matchReason,
            })),
          },
        });
        
        for (const match of geminiMatches) {
          await sendProactiveReminder(message, match);
        }
        
        if (geminiMatches.length > 0) {
          logger.info('Proactive triggers found via Gemini', {
            messageId: message.id,
            matchCount: geminiMatches.length,
          });
        }
        
        return geminiMatches;
      }
    }
    
    return [];
  } catch (error) {
    logger.error('Error checking proactive triggers', { error, messageId: message.id });
    return [];
  }
}

/**
 * Extract context (keywords, location) from message content
 * Used for SQL-based matching
 */
function extractContextFromMessage(content: string): ExtensionContextQuery {
  const keywords = extractSignificantWords(content.toLowerCase());
  
  // Try to detect location from common patterns
  const locationPatterns = [
    /\b(?:reached|arrived|at|in|visiting|landed|going to|heading to|came to)\s+(\w+)/i,
    /\b(?:goa|mumbai|delhi|bangalore|chennai|kolkata|hyderabad|pune|jaipur|ahmedabad)\b/i,
  ];
  
  let location: string | undefined;
  for (const pattern of locationPatterns) {
    const match = content.match(pattern);
    if (match) {
      location = match[1] || match[0];
      break;
    }
  }
  
  // Detect activity type
  let activity: string | undefined;
  if (/\b(travel|trip|flight|hotel|booking|vacation)\b/i.test(content)) {
    activity = 'travel';
  } else if (/\b(buy|purchase|order|amazon|flipkart|shopping)\b/i.test(content)) {
    activity = 'shopping';
  } else if (/\b(pay|payment|bank|transfer|upi)\b/i.test(content)) {
    activity = 'banking';
  }
  
  return {
    keywords: keywords.slice(0, 10), // Limit keywords
    location,
    activity,
  };
}

/**
 * Extract significant words from text (filter out stop words)
 */
function extractSignificantWords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'shall', 'can', 'need', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'under', 'again',
    'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
    'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'just',
    'don', 'now', 'i', 'me', 'my', 'you', 'your', 'he', 'she', 'it', 'we', 'they',
    'and', 'but', 'or', 'if', 'because', 'until', 'while', 'about',
  ]);
  
  return text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));
}

/**
 * Check if message content contains signals that suggest it might be a trigger
 * These are patterns that indicate status changes, locations, completions, etc.
 */
function checkForTriggerSignals(content: string): boolean {
  const lower = content.toLowerCase();
  
  const triggerPatterns = [
    // Location signals
    /\b(reached|arrived|at|in|visiting|landed|came to)\s+\w+/i,
    /\bjust\s+(reached|arrived|got|came|landed)/i,
    // Completion signals
    /\b(done|finished|completed|over|ended)\b/i,
    /\b(meeting|call|task|work)\s+(is\s+)?(done|over|finished)/i,
    // Status change signals
    /\b(feeling|got|have)\s+(better|free|time|sick|busy)/i,
    /\b(finally|now)\s+(free|done|available|home)/i,
    // Event signals
    /\b(approved|rejected|confirmed|cancelled)\b/i,
    /\b(paid|received|sent|delivered)\b/i,
    // Time signals
    /\b(leaving|going|heading|coming)\s+(home|back|to)/i,
    /\b(on\s+my\s+way|omw|otw)\b/i,
  ];
  
  return triggerPatterns.some(p => p.test(lower));
}

/**
 * Intelligent context matching using Gemini
 * This is the core intelligence - understands context, not just keywords
 */
async function intelligentContextMatch(
  message: StoredMessage,
  pendingEvents: StoredEvent[]
): Promise<ProactiveMatch[]> {
  if (!config.geminiApiKey) {
    logger.warn('Gemini API key not configured, skipping intelligent matching');
    return [];
  }

  try {
    const client = getGeminiClient();
    
    // Build rich context for Gemini
    const eventsContext = pendingEvents.map(e => ({
      id: e.id,
      title: e.title,
      originalMessage: e.source_message_content?.slice(0, 300),
      createdBy: e.created_by,
      condition: e.condition_value,
      contextTags: e.context_tags,
      location: e.location,
      chatId: e.chat_id,
      createdAt: e.created_at,
    }));

    const prompt = `You are an intelligent proactive reminder system for WhatsApp.

## Your Job
Analyze the incoming message and determine if it indicates a context where ANY pending task should be reminded to the user.

## IMPORTANT: Think Broadly
Don't just match keywords. Understand the CONTEXT and INTENT. Examples:
- "Just finished the meeting" could trigger "Send meeting notes to team"
- "Traffic is terrible" could trigger "Leave early for airport tomorrow"  
- "Mom called today" could trigger "Buy gift for mom's birthday"
- "Project approved!" could trigger "Send invoice to client"
- "Feeling lazy today" could trigger "Gym workout reminder"
- "Kids are asleep" could trigger "Call the contractor"
- "Pay day!" could trigger "Pay credit card bill"

## Current Pending Tasks:
${JSON.stringify(eventsContext, null, 2)}

## Incoming Message:
From: ${message.sender || 'Unknown'}
Chat: ${message.chat_id}
Content: "${message.content}"
Time: ${new Date(message.timestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

## Matching Criteria:
1. **Direct Context Match**: Message directly relates to a task's context
2. **Situational Match**: Message indicates a situation where a task becomes relevant
3. **Person Match**: Message mentions or is from someone related to a task
4. **Location Match**: Message indicates being at a location relevant to a task
5. **Time Match**: Message indicates a time context (e.g., "free now", "just finished")
6. **Emotional/State Match**: Message indicates a state relevant to a task
7. **Event Match**: Message mentions an event that triggers a dependent task

## DO NOT match if:
- The connection is too weak or speculative
- It would be annoying/irrelevant to remind now
- The message is from the same person who created the task (they already know)
- The task is clearly not relevant to current context

## Response Format (JSON ONLY):
[
  {
    "event_id": "id of matched event",
    "confidence": 0.0 to 1.0,
    "reason": "Brief explanation of why this matches",
    "suggested_action": "Optional: what user should do"
  }
]

Return empty array [] if no relevant matches. Be selective - only return high-confidence matches (>0.6).
Return ONLY the JSON array, no other text.`;

    const response = await client.chat.completions.create({
      model: config.geminiModel || 'gemini-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 2000,
    });

    const content = response.choices[0]?.message?.content?.trim() || '[]';
    
    // Parse the response
    let rawMatches: Array<{
      event_id: string;
      confidence: number;
      reason: string;
      suggested_action?: string;
    }> = [];

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        rawMatches = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      logger.warn('Failed to parse intelligent match response', { 
        content: content.slice(0, 500), 
        error: parseError,
      });
      return [];
    }

    // Convert to ProactiveMatch format
    const matches: ProactiveMatch[] = [];
    
    for (const match of rawMatches) {
      // Skip low confidence matches
      if (match.confidence < 0.6) continue;
      
      const event = pendingEvents.find(e => e.id === match.event_id);
      if (!event) continue;
      
      // Skip if message is from the same chat that created the task
      // (they probably remember their own task)
      if (event.chat_id === message.chat_id && match.confidence < 0.8) {
        continue;
      }
      
      matches.push({
        event,
        matchReason: match.reason,
        matchType: 'intelligent',
        confidence: match.confidence,
        suggestedAction: match.suggested_action,
      });
    }

    logger.debug('Intelligent matching completed', {
      messageId: message.id,
      pendingCount: pendingEvents.length,
      rawMatchCount: rawMatches.length,
      filteredMatchCount: matches.length,
    });

    return matches;
  } catch (error) {
    logger.error('Intelligent context matching failed', { error, messageId: message.id });
    return [];
  }
}

/**
 * Send a proactive reminder for a match
 * Uses Push Notification only (WhatsApp is read-only)
 */
async function sendProactiveReminder(
  message: StoredMessage,
  match: ProactiveMatch
): Promise<void> {
  const { event, matchReason, suggestedAction } = match;
  
  logger.info('Sending proactive reminder via Push', {
    eventId: event.id,
    eventTitle: event.title,
    matchReason,
    confidence: match.confidence,
  });

  // Build the reminder message
  let reminderBody = `You have a pending task: ${event.title}`;
  if (suggestedAction) {
    reminderBody += `\n\nSuggested action: ${suggestedAction}`;
  }
  reminderBody += `\n\nTriggered because: ${matchReason}`;

  // Send Web Push notification (WhatsApp is read-only)
  await sendNotification({
    type: 'reminder',
    event_id: event.id,
    title: 'Proactive Reminder',
    body: reminderBody,
    data: {
      trigger: 'proactive',
      triggerMessage: message.content.slice(0, 100),
      matchReason,
      confidence: match.confidence,
      suggestedAction,
    },
  });

  // Mark event as proactively triggered
  markEventProactivelyTriggered(event.id);
}

/**
 * Reset proactive trigger status for an event (e.g., after snooze)
 */
export async function resetProactiveTrigger(eventId: string): Promise<void> {
  dbResetProactiveTrigger(eventId);
  logger.debug('Proactive trigger reset for event', { eventId });
}

/**
 * Check multiple messages in batch (for efficiency)
 */
export async function checkBatchForProactiveTriggers(
  messages: StoredMessage[]
): Promise<Map<string, ProactiveMatch[]>> {
  const results = new Map<string, ProactiveMatch[]>();
  
  // Process in parallel but limit concurrency
  const batchSize = 5;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const promises = batch.map(async (msg) => {
      const matches = await checkForProactiveTriggers(msg);
      return { messageId: msg.id, matches };
    });
    
    const batchResults = await Promise.all(promises);
    for (const { messageId, matches } of batchResults) {
      results.set(messageId, matches);
    }
  }
  
  return results;
}

export default {
  checkForProactiveTriggers,
  resetProactiveTrigger,
  checkBatchForProactiveTriggers,
};
