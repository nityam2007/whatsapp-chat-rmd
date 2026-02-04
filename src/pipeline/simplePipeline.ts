/**
 * Simplified Pipeline (v0.9.0)
 * 
 * Only 3 stages:
 * 1. Heuristic Gate - Filter noise (saves 90% LLM costs)
 * 2. Gemini Extract - Classify + Extract in ONE call
 * 3. Store + Notify - Save event, send reminder if due
 * 
 * REMOVED: Classifier, RuleEngine, PatternLearner, ContextBuilder, IntentDetector
 */

import { StoredMessage, StoredEvent } from '../types/index.js';
import { 
  messageExists,
  storeEnhancedMessage,
  updateMessageHeuristic,
  updateMessagePipelineComplete,
  storePipelineLog,
  storeEvent,
  getEventBySourceMessage,
} from '../database/sqlite.js';
import { checkHeuristicGate } from './heuristicGate.js';
import { checkForProactiveTriggers } from '../services/proactiveTrigger.js';
import { sendNotification } from '../notifications/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

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

/**
 * Simple 3-stage pipeline
 */
export async function processMessageSimple(message: StoredMessage): Promise<StoredEvent | null> {
  const startTime = Date.now();
  
  logger.info('Simple pipeline started', { 
    messageId: message.id, 
    content: message.content.slice(0, 50),
  });
  
  try {
    // =====================================
    // DEDUP CHECK
    // =====================================
    if (messageExists(message.id)) {
      const existing = getEventBySourceMessage(message.id);
      if (existing) {
        logger.debug('Already processed', { messageId: message.id });
        return existing;
      }
    }

    // =====================================
    // STAGE 0: Store raw message
    // =====================================
    storeEnhancedMessage({
      ...message,
      heuristic_passed: null,
      heuristic_score: null,
      heuristic_signals: null,
      classification_type: null,
      classification_confidence: null,
      extraction_success: null,
      extraction_event_id: null,
      pipeline_completed: false,
      pipeline_error: null,
    });

    // =====================================
    // STAGE 0.5: Proactive Check (runs for ALL messages)
    // =====================================
    try {
      await checkForProactiveTriggers(message);
    } catch (e) {
      logger.warn('Proactive check failed', { error: e });
    }

    // =====================================
    // STAGE 1: Heuristic Gate (filter noise)
    // =====================================
    const heuristic = checkHeuristicGate(message.content);
    
    updateMessageHeuristic(
      message.id, 
      heuristic.hasSignal, 
      heuristic.score, 
      heuristic.signals
    );
    
    storePipelineLog({
      message_id: message.id,
      stage: 'heuristic',
      status: heuristic.hasSignal ? 'passed' : 'dropped',
      data: { score: heuristic.score, signals: heuristic.signals.slice(0, 5) },
      duration_ms: Date.now() - startTime,
    });
    
    if (!heuristic.hasSignal) {
      logger.debug('No signal, dropped', { messageId: message.id, score: heuristic.score });
      updateMessagePipelineComplete(message.id);
      return null;
    }

    // =====================================
    // STAGE 2: Gemini Extract (classify + extract in ONE call)
    // =====================================
    const extraction = await extractWithGemini(message);
    
    storePipelineLog({
      message_id: message.id,
      stage: 'extraction',
      status: extraction ? 'success' : 'no_event',
      data: extraction ? { title: extraction.title, type: extraction.event_type } : {},
      duration_ms: Date.now() - startTime,
    });
    
    if (!extraction) {
      logger.debug('No event extracted', { messageId: message.id });
      updateMessagePipelineComplete(message.id);
      return null;
    }

    // =====================================
    // STAGE 3: Store + Notify
    // =====================================
    const event: StoredEvent = {
      id: uuidv4(),
      title: extraction.title,
      event_type: extraction.event_type,
      event_date: extraction.event_date || null,
      event_time: extraction.event_time || null,
      reminder_time: extraction.reminder_time || null,
      participants: extraction.participants || [],
      location: extraction.location || null,
      status: 'pending',
      source_message_id: message.id,
      source_message_content: message.content,
      chat_id: message.chat_id,
      created_by: message.sender || 'unknown',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      confidence: extraction.confidence || 0.8,
      context_tags: extraction.context_tags || [],
      trigger_keywords: extraction.trigger_keywords || [],
    };
    
    storeEvent(event);
    
    storePipelineLog({
      message_id: message.id,
      stage: 'stored',
      status: 'success',
      data: { eventId: event.id, title: event.title },
      duration_ms: Date.now() - startTime,
    });
    
    logger.info('Event created', { 
      messageId: message.id, 
      eventId: event.id, 
      title: event.title,
      duration: Date.now() - startTime,
    });
    
    // Send notification if event is due soon
    if (event.reminder_time) {
      const reminderDate = new Date(event.reminder_time);
      const now = new Date();
      const diffMs = reminderDate.getTime() - now.getTime();
      
      // If due within 1 hour, notify immediately
      if (diffMs > 0 && diffMs < 60 * 60 * 1000) {
        await sendNotification({
          type: 'reminder',
          event_id: event.id,
          title: 'Upcoming Reminder',
          body: event.title,
        });
      }
    }
    
    updateMessagePipelineComplete(message.id);
    return event;
    
  } catch (error) {
    logger.error('Pipeline failed', { error, messageId: message.id });
    updateMessagePipelineComplete(message.id);
    return null;
  }
}

/**
 * Single Gemini call that does BOTH classification AND extraction
 */
async function extractWithGemini(message: StoredMessage): Promise<{
  title: string;
  event_type: string;
  event_date?: string;
  event_time?: string;
  reminder_time?: string;
  participants?: string[];
  location?: string;
  confidence?: number;
  context_tags?: string[];
  trigger_keywords?: string[];
} | null> {
  if (!config.geminiApiKey) {
    logger.error('Gemini API key not configured');
    return null;
  }

  const client = getGeminiClient();
  
  const prompt = `You are a WhatsApp message analyzer. Extract event/reminder/task information.

MESSAGE:
From: ${message.sender || 'Unknown'}
Chat: ${message.chat_id}
Content: "${message.content}"

TASK:
1. Determine if this message contains an actionable event, reminder, or task
2. If yes, extract the details. If no, return null.

RETURN JSON (or null if no event):
{
  "title": "Short task description (max 10 words)",
  "event_type": "reminder|event|task|meeting|deadline",
  "event_date": "YYYY-MM-DD or null",
  "event_time": "HH:MM or null",
  "reminder_time": "ISO datetime when to remind, or null",
  "participants": ["names mentioned"],
  "location": "place if mentioned",
  "confidence": 0.0-1.0,
  "context_tags": ["goa", "travel", "shopping", etc - for proactive matching],
  "trigger_keywords": ["keywords that should trigger this reminder"]
}

EXAMPLES:
- "remind me to call mom tomorrow at 5pm" → reminder to call mom
- "meeting with john on friday" → meeting event
- "bring potato from market" → task
- "haha that's funny" → null (not actionable)
- "kal 3 baje doctor appointment" → reminder for tomorrow 3pm

Return ONLY the JSON object or null. No other text.`;

  try {
    const response = await client.chat.completions.create({
      model: config.geminiModel || 'gemini-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content?.trim();
    
    if (!content || content.toLowerCase() === 'null') {
      return null;
    }

    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return null;
  } catch (error) {
    logger.error('Gemini extraction failed', { error, messageId: message.id });
    return null;
  }
}

export default { processMessageSimple };
