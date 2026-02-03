/**
 * Proactive Trigger Service
 * 
 * Monitors ALL incoming messages and uses intelligent matching to detect
 * when any message relates to pending events/tasks.
 * 
 * MATCHING STRATEGY (v0.8.1):
 * 1. FAISS vector similarity (fast, cheap) - finds semantically similar events
 * 2. Gemini LLM (smart, expensive) - only for ambiguous cases or low FAISS confidence
 * 
 * This is NOT just keyword matching - it's intelligent context understanding.
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
} from '../database/sqlite.js';
import { sendNotification } from '../notifications/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import OpenAI from 'openai';
import { generateEmbedding } from '../vector/faiss.js';

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
  matchType: 'faiss' | 'intelligent' | 'keyword';
  confidence: number;
  suggestedAction?: string;
}

// FAISS similarity threshold for proactive matching
const FAISS_HIGH_CONFIDENCE_THRESHOLD = 0.75;  // High enough to trigger directly
const FAISS_MEDIUM_CONFIDENCE_THRESHOLD = 0.55; // Worth checking with Gemini
const KEYWORD_MATCH_CONFIDENCE = 0.65; // Confidence for keyword-based matches

/**
 * Check if an incoming message triggers any pending events
 * Uses FAISS first for speed, then Gemini for ambiguous cases
 * 
 * This is called for EVERY incoming message
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
    // Get all pending events
    const pendingEvents = getEventsForProactiveTrigger(100);
    
    logger.info('Found pending events for proactive matching', { 
      messageId: message.id,
      pendingEventCount: pendingEvents.length,
      eventTitles: pendingEvents.slice(0, 5).map(e => e.title),
    });

    if (pendingEvents.length === 0) {
      logger.debug('No pending events for proactive matching');
      return [];
    }

    // =============================================
    // Stage 1: FAISS Vector Similarity (Fast & Cheap)
    // =============================================
    const faissMatches = await faissContextMatch(message, pendingEvents);
    
    // Log FAISS stage
    storePipelineLog({
      message_id: message.id,
      stage: 'proactive_faiss',
      status: faissMatches.length > 0 ? 'matches_found' : 'no_matches',
      data: {
        pendingEventCount: pendingEvents.length,
        faissMatchCount: faissMatches.length,
        matches: faissMatches.map(m => ({
          eventId: m.event.id,
          eventTitle: m.event.title,
          confidence: m.confidence,
        })),
      },
    });
    
    // If we have high-confidence FAISS matches, use them directly
    const highConfidenceFaiss = faissMatches.filter(m => m.confidence >= FAISS_HIGH_CONFIDENCE_THRESHOLD);
    
    if (highConfidenceFaiss.length > 0) {
      logger.info('Using high-confidence FAISS matches (skipping Gemini)', {
        messageId: message.id,
        matchCount: highConfidenceFaiss.length,
      });
      
      // Send proactive reminders for matches
      for (const match of highConfidenceFaiss) {
        await sendProactiveReminder(message, match);
      }
      
      return highConfidenceFaiss;
    }
    
    // =============================================
    // Stage 1.5: Keyword Matching (Fast fallback when FAISS doesn't find matches)
    // This catches cases like "just reached goa" matching "Get cashew from goa"
    // =============================================
    let keywordMatches: ProactiveMatch[] = [];
    if (faissMatches.length === 0) {
      keywordMatches = keywordContextMatch(message, pendingEvents);
      
      storePipelineLog({
        message_id: message.id,
        stage: 'proactive_keyword',
        status: keywordMatches.length > 0 ? 'matches_found' : 'no_matches',
        data: {
          pendingEventCount: pendingEvents.length,
          keywordMatchCount: keywordMatches.length,
          matches: keywordMatches.map(m => ({
            eventId: m.event.id,
            eventTitle: m.event.title,
            confidence: m.confidence,
            reason: m.matchReason,
          })),
        },
      });
      
      // If we have high-confidence keyword matches, use them
      const highConfidenceKeyword = keywordMatches.filter(m => m.confidence >= KEYWORD_MATCH_CONFIDENCE);
      if (highConfidenceKeyword.length > 0) {
        logger.info('Using high-confidence keyword matches', {
          messageId: message.id,
          matchCount: highConfidenceKeyword.length,
        });
        
        // Send proactive reminders for keyword matches
        for (const match of highConfidenceKeyword) {
          await sendProactiveReminder(message, match);
        }
        
        return highConfidenceKeyword;
      }
    }

    // =============================================
    // Stage 2: Gemini LLM (Smart but Expensive)
    // Only if FAISS found medium-confidence matches OR no matches but message seems promising
    // =============================================
    const mediumConfidenceFaiss = faissMatches.filter(
      m => m.confidence >= FAISS_MEDIUM_CONFIDENCE_THRESHOLD && m.confidence < FAISS_HIGH_CONFIDENCE_THRESHOLD
    );
    
    // Also consider keyword matches that didn't meet the high threshold
    const mediumConfidenceKeyword = keywordMatches.filter(m => m.confidence >= 0.5 && m.confidence < KEYWORD_MATCH_CONFIDENCE);
    
    // Check if message content suggests it might be a trigger (location, status, completion)
    const mightBeTrigger = checkForTriggerSignals(message.content);
    
    // Only use Gemini if:
    // 1. We have medium-confidence FAISS or keyword matches to validate, OR
    // 2. Message looks like a trigger but nothing found high matches
    const shouldUseGemini = mediumConfidenceFaiss.length > 0 || 
                           mediumConfidenceKeyword.length > 0 ||
                           (mightBeTrigger && faissMatches.length === 0 && keywordMatches.length === 0);
    
    if (shouldUseGemini && config.geminiApiKey) {
      // Pass medium-confidence events to Gemini for validation
      const eventsToCheck = mediumConfidenceFaiss.length > 0 
        ? mediumConfidenceFaiss.map(m => m.event)
        : pendingEvents.slice(0, 20); // Limit to top 20 for cost
      
      const geminiMatches = await intelligentContextMatch(message, eventsToCheck);
      
      // Log Gemini stage
      storePipelineLog({
        message_id: message.id,
        stage: 'proactive_gemini',
        status: geminiMatches.length > 0 ? 'matches_found' : 'no_matches',
        data: {
          eventsChecked: eventsToCheck.length,
          geminiMatchCount: geminiMatches.length,
          matches: geminiMatches.map(m => ({
            eventId: m.event.id,
            eventTitle: m.event.title,
            confidence: m.confidence,
            reason: m.matchReason,
          })),
        },
      });
      
      // Send proactive reminders for matches
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
    
    // No matches found
    return [];
  } catch (error) {
    logger.error('Error checking proactive triggers', { error, messageId: message.id });
    return [];
  }
}

/**
 * FAISS-based context matching (fast & cheap)
 * Uses vector similarity to find semantically related pending events
 */
async function faissContextMatch(
  message: StoredMessage,
  pendingEvents: StoredEvent[]
): Promise<ProactiveMatch[]> {
  logger.info('FAISS context matching started', {
    messageId: message.id,
    messageContent: message.content.slice(0, 50),
    pendingEventCount: pendingEvents.length,
  });

  try {
    // Generate embedding for the incoming message
    const messageEmbedding = await generateEmbedding(message.content);
    
    logger.debug('Message embedding generated', { 
      messageId: message.id, 
      embeddingLength: messageEmbedding.length,
    });
    
    const matches: ProactiveMatch[] = [];
    
    // Compare with each pending event's context
    for (const event of pendingEvents) {
      // Build event context for embedding
      const eventContext = [
        event.title || '',
        event.source_message_content || '',
        event.location || '',
        (event.context_tags || []).join(' '),
        (event.trigger_keywords || []).join(' '),
        event.condition_value || '',
      ].filter(Boolean).join(' ');
      
      if (!eventContext.trim()) continue;
      
      try {
        // Generate embedding for event context
        const eventEmbedding = await generateEmbedding(eventContext);
        
        // Calculate cosine similarity
        const similarity = cosineSimilarity(messageEmbedding, eventEmbedding);
        
        logger.debug('FAISS similarity calculated', {
          messageId: message.id,
          eventId: event.id,
          eventTitle: event.title,
          similarity: similarity.toFixed(3),
          threshold: FAISS_MEDIUM_CONFIDENCE_THRESHOLD,
          passed: similarity >= FAISS_MEDIUM_CONFIDENCE_THRESHOLD,
        });
        
        if (similarity >= FAISS_MEDIUM_CONFIDENCE_THRESHOLD) {
          matches.push({
            event,
            matchReason: `Semantic similarity: ${(similarity * 100).toFixed(0)}%`,
            matchType: 'faiss',
            confidence: similarity,
            suggestedAction: event.title || undefined,
          });
        }
      } catch (embedError) {
        logger.debug('Failed to generate embedding for event', { 
          eventId: event.id, 
          error: embedError 
        });
      }
    }
    
    // Sort by confidence
    matches.sort((a, b) => b.confidence - a.confidence);
    
    logger.debug('FAISS context matching completed', {
      messageId: message.id,
      pendingEventCount: pendingEvents.length,
      matchCount: matches.length,
      topMatch: matches[0] ? {
        eventTitle: matches[0].event.title,
        confidence: matches[0].confidence,
      } : null,
    });
    
    return matches;
  } catch (error) {
    logger.error('FAISS context matching failed', { error, messageId: message.id });
    return [];
  }
}

/**
 * Calculate cosine similarity between two embedding vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  
  return dotProduct / denominator;
}

/**
 * Keyword-based matching fallback
 * Checks if message content contains keywords from event context
 * This works even without proper embeddings
 */
function keywordContextMatch(
  message: StoredMessage,
  pendingEvents: StoredEvent[]
): ProactiveMatch[] {
  const messageWords = extractSignificantWords(message.content.toLowerCase());
  const matches: ProactiveMatch[] = [];
  
  logger.debug('Keyword matching started', {
    messageId: message.id,
    messageWords,
  });
  
  for (const event of pendingEvents) {
    // Extract keywords from event
    const eventKeywords = new Set<string>();
    
    // Add location as keyword
    if (event.location) {
      extractSignificantWords(event.location.toLowerCase()).forEach(w => eventKeywords.add(w));
    }
    
    // Add trigger keywords
    if (event.trigger_keywords) {
      event.trigger_keywords.forEach(kw => {
        extractSignificantWords(kw.toLowerCase()).forEach(w => eventKeywords.add(w));
      });
    }
    
    // Add context tags
    if (event.context_tags) {
      event.context_tags.forEach(tag => {
        if (tag.length >= 3) eventKeywords.add(tag.toLowerCase());
      });
    }
    
    // Add significant words from title
    if (event.title) {
      extractSignificantWords(event.title.toLowerCase()).forEach(w => eventKeywords.add(w));
    }
    
    // Check for keyword overlap
    const matchedKeywords = messageWords.filter(w => eventKeywords.has(w));
    
    if (matchedKeywords.length > 0) {
      // Check if message indicates arrival/location/status
      const isLocationTrigger = /\b(reached|arrived|at|in|visiting|landed|came|going|heading)\b/i.test(message.content);
      
      // Calculate confidence based on match quality
      const confidence = isLocationTrigger && matchedKeywords.length > 0 
        ? KEYWORD_MATCH_CONFIDENCE + (matchedKeywords.length * 0.05)
        : 0.5 + (matchedKeywords.length * 0.1);
      
      logger.info('Keyword match found', {
        messageId: message.id,
        eventId: event.id,
        eventTitle: event.title,
        matchedKeywords,
        eventKeywords: Array.from(eventKeywords),
        isLocationTrigger,
        confidence,
      });
      
      matches.push({
        event,
        matchReason: `Keyword match: ${matchedKeywords.join(', ')}${isLocationTrigger ? ' (location trigger)' : ''}`,
        matchType: 'keyword',
        confidence: Math.min(confidence, 0.9),
        suggestedAction: event.title || undefined,
      });
    }
  }
  
  // Sort by confidence
  matches.sort((a, b) => b.confidence - a.confidence);
  
  return matches;
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
