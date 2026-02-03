/**
 * Small LLM Classifier Module
 * 
 * Uses a small, fast LLM for initial classification of messages
 * into event types. Minimal token usage.
 */

import OpenAI from 'openai';
import { ClassificationResult, EventType } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

const CLASSIFICATION_PROMPT = `You are a message classifier. Classify the following message into ONE of these categories:
- new_event: Message describes a new event, meeting, appointment, reminder, DEADLINE, due date, task, or anything with a time/date reference
- update_event: Message updates or changes an existing event (time, location, etc.)
- signal_event: Message is a trigger or condition for a pending event (e.g., "I've arrived", "meeting is done")
- irrelevant: Message is casual chat with NO time, date, deadline, or scheduling information

IMPORTANT: If a message mentions ANY date, time, deadline, or due date, it is likely new_event, NOT irrelevant.
Examples of new_event:
- "Meeting tomorrow at 3pm" → new_event
- "Deadline is February 8" → new_event
- "Project due next week" → new_event
- "Reminder to call mom" → new_event

Examples of irrelevant:
- "Ok sounds good" → irrelevant
- "How are you?" → irrelevant
- "Thanks!" → irrelevant

Respond with ONLY a JSON object in this exact format:
{"event_type": "category", "confidence": 0.0}

Where confidence is a number between 0 and 1.

Message to classify:
`;

let openaiClient: OpenAI | null = null;
let geminiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openaiApiKey,
    });
  }
  return openaiClient;
}

/**
 * Get Gemini client (OpenAI-compatible)
 */
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
 * Check if Gemini is configured
 */
function isGeminiConfigured(): boolean {
  return !!config.geminiApiKey;
}

/**
 * Get the LLM client for classification (prefers Gemini, falls back to OpenAI)
 */
function getLLMClient(): { client: OpenAI; model: string; provider: string } {
  if (isGeminiConfigured()) {
    return {
      client: getGeminiClient(),
      model: config.geminiModel,
      provider: 'gemini',
    };
  }
  return {
    client: getOpenAIClient(),
    model: config.openaiModelSmall,
    provider: 'openai',
  };
}

/**
 * Classifies a message using the small LLM
 */
export async function classifyMessage(content: string): Promise<ClassificationResult> {
  logger.debug('Classifying message', { contentLength: content.length });

  // If no API key configured (neither Gemini nor OpenAI), use fallback
  if (!config.geminiApiKey && !config.openaiApiKey) {
    logger.warn('No LLM API key configured, using fallback classification');
    return fallbackClassification(content);
  }

  try {
    const { client, model, provider } = getLLMClient();
    
    logger.debug('Using LLM provider for classification', { provider, model });
    
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content: CLASSIFICATION_PROMPT + content,
        },
      ],
      temperature: 0.1, // Low temperature for consistent classification
      max_tokens: 50,
    });

    const responseText = response.choices[0]?.message?.content?.trim() || '';
    
    // Parse JSON response
    const result = parseClassificationResponse(responseText);
    
    logger.debug('Classification result', {
      eventType: result.event_type,
      confidence: result.confidence,
      provider,
    });

    return result;
  } catch (error) {
    logger.error('Classification error', { error });
    return fallbackClassification(content);
  }
}

/**
 * Parses the LLM response into a ClassificationResult
 */
function parseClassificationResponse(response: string): ClassificationResult {
  try {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Validate event_type
      const validTypes: EventType[] = ['new_event', 'update_event', 'signal_event', 'irrelevant'];
      if (!validTypes.includes(parsed.event_type)) {
        parsed.event_type = 'irrelevant';
      }

      // Validate confidence
      const confidence = parseFloat(parsed.confidence);
      if (isNaN(confidence) || confidence < 0 || confidence > 1) {
        parsed.confidence = 0.5;
      } else {
        parsed.confidence = confidence;
      }

      return {
        event_type: parsed.event_type,
        confidence: parsed.confidence,
      };
    }
  } catch {
    logger.warn('Failed to parse classification response', { response });
  }

  // Default to irrelevant if parsing fails
  return {
    event_type: 'irrelevant',
    confidence: 0.3,
  };
}

/**
 * Fallback classification when LLM is unavailable
 * Uses comprehensive keyword-based heuristics
 */
function fallbackClassification(content: string): ClassificationResult {
  const lower = content.toLowerCase();

  // Check for cancel/update signals FIRST (highest priority)
  const cancelKeywords = [
    'cancel', 'cancelled', 'canceled', 'cancelling',
    'skip', 'drop', 'abort', 'call off',
    'not happening', 'won\'t happen', 'wont happen',
    'forget about', 'never mind', 'nevermind',
  ];
  if (cancelKeywords.some(k => lower.includes(k))) {
    return { event_type: 'update_event', confidence: 0.7 };
  }

  // Check for reschedule/update signals
  const updateKeywords = [
    'change', 'update', 'move to', 'moved to', 'shift to',
    'reschedule', 'postpone', 'delay', 'push to',
    'new time', 'new date', 'different time', 'different date',
    'instead of', 'actually', 'correction',
  ];
  if (updateKeywords.some(k => lower.includes(k))) {
    return { event_type: 'update_event', confidence: 0.65 };
  }

  // Check for signal/trigger keywords
  const signalKeywords = [
    'arrived', 'i\'m here', 'im here', 'reached',
    'done', 'finished', 'completed', 'over',
    'starting', 'started', 'beginning',
    'ready', 'all set', 'good to go',
  ];
  if (signalKeywords.some(k => lower.includes(k))) {
    return { event_type: 'signal_event', confidence: 0.5 };
  }

  // Check for new event keywords (comprehensive list)
  const eventKeywords = [
    // Meetings & calls
    'meeting', 'call', 'sync', 'catchup', 'catch up', '1:1', 'one on one',
    // Reminders
    'remind', 'reminder', 'don\'t forget', 'dont forget', 'remember',
    // Appointments
    'appointment', 'schedule', 'book', 'reserve',
    // Events
    'event', 'party', 'birthday', 'wedding', 'dinner', 'lunch', 'breakfast',
    // Tasks
    'deadline', 'due', 'submit', 'task', 'todo', 'to do', 'to-do',
    // Errands
    'bring', 'get', 'buy', 'pick up', 'drop off', 'collect', 'fetch',
    'pay', 'return', 'deliver', 'send', 'post',
  ];
  
  const timeKeywords = [
    // Today/tomorrow
    'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening',
    'tmrw', 'tmr', 'tomo',
    // Days
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
    // Months
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    // Relative
    'next', 'this', 'coming', 'at', 'by', 'before', 'after',
    // Time markers
    'am', 'pm', 'o\'clock', 'oclock',
  ];
  
  // Time patterns (regex)
  const timePatterns = [
    /\d{1,2}[:\.\-]\d{2}/,           // 10:30, 10.30
    /\d{1,2}\s*(am|pm)/i,            // 10am, 10 pm
    /\d{1,2}\s*o'?clock/i,           // 3 o'clock
    /in\s+\d+\s*(hour|min|day)/i,    // in 2 hours
    /\d{1,2}\/\d{1,2}/,              // 12/25
  ];

  const hasEvent = eventKeywords.some(k => lower.includes(k));
  const hasTime = timeKeywords.some(k => lower.includes(k));
  const hasTimePattern = timePatterns.some(p => p.test(lower));

  // Strong confidence if both event word and time reference
  if (hasEvent && (hasTime || hasTimePattern)) {
    return { event_type: 'new_event', confidence: 0.7 };
  }
  
  // Medium confidence if has explicit event word
  if (hasEvent) {
    return { event_type: 'new_event', confidence: 0.55 };
  }
  
  // Medium confidence if has clear time patterns
  if (hasTimePattern) {
    return { event_type: 'new_event', confidence: 0.5 };
  }
  
  // Low confidence if just has time words
  if (hasTime) {
    return { event_type: 'new_event', confidence: 0.4 };
  }

  return { event_type: 'irrelevant', confidence: 0.7 };
}

export default { classifyMessage };
