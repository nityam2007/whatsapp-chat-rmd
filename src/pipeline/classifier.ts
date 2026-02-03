/**
 * Small LLM Classifier Module
 * 
 * Uses a small, fast LLM for initial classification of messages
 * into event types. Minimal token usage.
 * 
 * ENHANCED WITH SEMANTIC FEW-SHOT LEARNING:
 * - Finds similar past messages using embeddings
 * - Includes their classifications as examples for the LLM
 * - Improves accuracy through real-world examples
 * 
 * LOGGING: This module logs ALL LLM calls to database and log files.
 */

import OpenAI from 'openai';
import { ClassificationResult, EventType } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { storeLLMCall } from '../database/sqlite.js';
import { logLLM, logError, logSuccess, logWarn } from '../utils/loudLogger.js';
import { getFewShotExamples, initSemanticSearch } from '../vector/semanticSearch.js';

const CLASSIFICATION_PROMPT = `You are a message classifier. Classify the following message into ONE of these categories:
- new_event: Message describes a new event, meeting, appointment, reminder, DEADLINE, due date, task, or anything with a time/date reference
- update_event: Message updates or changes an existing event (time, location, etc.) - includes time-only messages that likely refer to a previous event
- signal_event: Message is a trigger or condition for a pending event (e.g., "I've arrived", "meeting is done")
- irrelevant: Message is casual chat with NO time, date, deadline, or scheduling information

IMPORTANT: If a message mentions ANY date, time, deadline, or due date, it is likely new_event or update_event, NOT irrelevant.

Examples of new_event:
- "Meeting tomorrow at 3pm" → new_event
- "Deadline is February 8" → new_event
- "Project due next week" → new_event
- "Reminder to call mom" → new_event

Examples of update_event:
- "Let's make it 5pm instead" → update_event
- "now at 5 PM" → update_event (likely updating a previous event)
- "postponed to tomorrow" → update_event
- "changed to 10am" → update_event
- "actually 3pm" → update_event

Examples of irrelevant:
- "Ok sounds good" → irrelevant
- "How are you?" → irrelevant
- "Thanks!" → irrelevant

CRITICAL: Short messages containing just a time (like "5pm", "now at 5 PM", "today 10am") are LIKELY update_event because they're usually responding to a previous scheduling discussion. Do NOT classify them as irrelevant.

Respond with ONLY a JSON object in this exact format:
{"event_type": "category", "confidence": 0.0}

Where confidence is a number between 0 and 1.
`;

// Dynamic prompt with few-shot examples
function buildClassificationPrompt(content: string, fewShotExamples?: Array<{ message: string; classification: string; similarity: number }>): string {
  let prompt = CLASSIFICATION_PROMPT;
  
  // Add semantic few-shot examples if available
  if (fewShotExamples && fewShotExamples.length > 0) {
    prompt += '\nREAL EXAMPLES from similar past messages:\n';
    for (const example of fewShotExamples) {
      // Only include high-similarity examples
      if (example.similarity >= 0.6) {
        prompt += `- "${example.message.slice(0, 100)}" → ${example.classification}\n`;
      }
    }
    prompt += '\n';
  }
  
  prompt += `Message to classify:\n${content}`;
  
  return prompt;
}

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
 * 
 * ENHANCED: Uses semantic few-shot examples from similar past messages
 * LOGS: All inputs and outputs are logged to database and files
 */
export async function classifyMessage(content: string, messageId?: string, _chatId?: string): Promise<ClassificationResult> {
  const startTime = Date.now();
  const msgId = messageId || 'unknown';
  
  logger.debug('Classifying message', { contentLength: content.length, messageId: msgId });

  // If no API key configured (neither Gemini nor OpenAI), use fallback
  if (!config.geminiApiKey && !config.openaiApiKey) {
    logWarn('CLASSIFIER', 'No LLM API key configured, using fallback', { messageId: msgId });
    const result = fallbackClassification(content);
    logSuccess('CLASSIFIER', `Fallback classification: ${result.event_type}`, { confidence: result.confidence });
    return result;
  }

  const { client, model, provider } = getLLMClient();
  
  // Get semantic few-shot examples for improved accuracy
  let fewShotExamples: Array<{ message: string; classification: string; similarity: number }> = [];
  try {
    await initSemanticSearch();
    fewShotExamples = await getFewShotExamples(content, 3);
    if (fewShotExamples.length > 0) {
      logger.debug('Found few-shot examples', { 
        count: fewShotExamples.length, 
        topSimilarity: fewShotExamples[0]?.similarity 
      });
    }
  } catch (error) {
    logger.warn('Failed to get few-shot examples', { error });
  }
  
  // Build prompt with few-shot examples
  const fullPrompt = buildClassificationPrompt(content, fewShotExamples);
  
  try {
    // Log the API call start
    logLLM('classification', msgId, {
      model,
      provider,
      prompt: fullPrompt,
    });
    
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'user',
          content: fullPrompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const durationMs = Date.now() - startTime;
    const responseText = response.choices[0]?.message?.content?.trim() || '';
    const finishReason = response.choices[0]?.finish_reason || 'unknown';
    const tokensUsed = response.usage?.total_tokens || 0;
    
    // Log the response
    logLLM('classification', msgId, {
      model,
      provider,
      prompt: fullPrompt,
    }, {
      response: responseText,
      finishReason,
      tokens: tokensUsed,
      durationMs,
    });

    // Check if response was truncated
    if (finishReason === 'length') {
      logWarn('CLASSIFIER', 'Response truncated, using fallback', { responseText: responseText.slice(0, 50), messageId: msgId });
      
      // Store failed call in DB
      storeLLMCall({
        message_id: msgId,
        call_type: 'classification',
        model,
        provider,
        prompt: fullPrompt,
        response: responseText,
        finish_reason: finishReason,
        tokens_total: tokensUsed,
        duration_ms: durationMs,
        success: false,
        error: 'Response truncated',
      });
      
      return fallbackClassification(content);
    }
    
    // Check if response is empty
    if (!responseText) {
      logError('CLASSIFIER', 'Empty response from LLM', null, { messageId: msgId, model, provider });
      
      storeLLMCall({
        message_id: msgId,
        call_type: 'classification',
        model,
        provider,
        prompt: fullPrompt,
        response: '',
        finish_reason: finishReason,
        tokens_total: tokensUsed,
        duration_ms: durationMs,
        success: false,
        error: 'Empty response',
      });
      
      return fallbackClassification(content);
    }
    
    // Parse JSON response
    const result = parseClassificationResponse(responseText);
    
    // Store successful call in DB
    storeLLMCall({
      message_id: msgId,
      call_type: 'classification',
      model,
      provider,
      prompt: fullPrompt,
      response: responseText,
      response_parsed: JSON.stringify(result),
      finish_reason: finishReason,
      tokens_prompt: response.usage?.prompt_tokens || 0,
      tokens_completion: response.usage?.completion_tokens || 0,
      tokens_total: tokensUsed,
      duration_ms: durationMs,
      success: true,
    });
    
    logSuccess('CLASSIFIER', `Classified as ${result.event_type}`, { 
      confidence: result.confidence, 
      messageId: msgId,
      durationMs,
    });

    return result;
    
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    
    // YELL about the error
    logError('CLASSIFIER', 'LLM API call failed', error, { messageId: msgId, model, provider });
    
    // Store failed call in DB
    storeLLMCall({
      message_id: msgId,
      call_type: 'classification',
      model,
      provider,
      prompt: fullPrompt,
      duration_ms: durationMs,
      success: false,
      error: errorMsg,
    });
    
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
        logWarn('CLASSIFIER', `Invalid event_type: ${parsed.event_type}, defaulting to irrelevant`);
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
    } else {
      logWarn('CLASSIFIER', 'No JSON found in response', { response: response.slice(0, 100) });
    }
  } catch (error) {
    logError('CLASSIFIER', 'Failed to parse response JSON', error, { response: response.slice(0, 100) });
  }

  // Default to irrelevant if parsing fails (use 0.3 to indicate parse failure)
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
  logWarn('CLASSIFIER', 'Using fallback (keyword-based) classification', { content: content.slice(0, 50) });
  
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
