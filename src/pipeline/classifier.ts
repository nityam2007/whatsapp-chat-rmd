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

const CLASSIFICATION_PROMPT = `You are a STRICT message classifier for a reminder/calendar system. Your job is to identify messages that describe SCHEDULABLE events.

IMPORTANT RULES:
1. A message is ONLY an event if it has a SPECIFIC time, date, or deadline
2. Vague requests without time ("send email", "pay amount") are NOT events - they are just tasks
3. Acknowledgments ("Done", "Ok", "Ha bhai") are ALWAYS irrelevant
4. Casual conversation about work/money without scheduling is irrelevant
5. Be CONSERVATIVE - when in doubt, classify as irrelevant

Categories:
- new_event: Message has a SPECIFIC date/time/deadline (e.g., "meeting tomorrow at 3pm", "deadline Feb 8", "call me at 5")
- update_event: Updates an existing event's time/date (e.g., "make it 5pm instead", "postponed to tomorrow")
- signal_event: Completion trigger with clear context (e.g., "meeting is done, start the next task")
- irrelevant: Everything else - casual chat, acknowledgments, vague requests, general discussion

Examples of new_event (HAS specific time/date):
- "Meeting tomorrow at 3pm" → new_event
- "Deadline is February 8" → new_event  
- "Call me at 5 baje" → new_event
- "Kal 10 baje milte hai" → new_event

Examples of irrelevant (NO specific time/date):
- "Done" → irrelevant (just acknowledgment)
- "Ok kale payment thai jase" → irrelevant (vague, no specific time)
- "Email mokal" → irrelevant (no time specified)
- "5 month nu kari de" → irrelevant (duration, not a specific date/time)
- "Payment ketlu thase?" → irrelevant (question about amount)
- "Ha bhai" → irrelevant (acknowledgment)
- "Theek che" → irrelevant (acknowledgment)

Examples of update_event:
- "Actually 5pm nahi 6pm" → update_event
- "Postponed to next week" → update_event
- "Changed to Monday" → update_event

Examples of signal_event (RARE - needs clear trigger context):
- "I've arrived at office, start the backup" → signal_event
- "Meeting finished, send the notes" → signal_event

Respond with ONLY a JSON object: {"event_type": "category", "confidence": 0.0}
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
 * NOW MORE CONSERVATIVE - requires specific time/date for events
 */
function fallbackClassification(content: string): ClassificationResult {
  logWarn('CLASSIFIER', 'Using fallback (keyword-based) classification', { content: content.slice(0, 50) });
  
  const lower = content.toLowerCase();
  
  // STRICT: Single word or very short acknowledgments are ALWAYS irrelevant
  const acknowledgments = [
    'done', 'ok', 'okay', 'yes', 'no', 'sure', 'ha', 'haan', 'nai', 'nahi',
    'theek', 'sahi', 'accha', 'cool', 'nice', 'great', 'perfect', 'fine',
    'bas', 'chalo', 'chal', 'hmm', 'ohh', 'ahh', 'wow', 'thanks', 'thx',
  ];
  
  const cleanContent = lower.replace(/[.!?,]/g, '').trim();
  if (acknowledgments.includes(cleanContent) || cleanContent.length < 5) {
    return { event_type: 'irrelevant', confidence: 0.95 };
  }

  // Check for cancel/update signals FIRST (highest priority)
  const cancelKeywords = [
    'cancel', 'cancelled', 'canceled', 'cancelling',
    'skip', 'abort', 'call off',
    'not happening', 'won\'t happen', 'wont happen',
    'forget about', 'never mind', 'nevermind',
  ];
  if (cancelKeywords.some(k => lower.includes(k))) {
    return { event_type: 'update_event', confidence: 0.7 };
  }

  // Check for reschedule/update signals
  const updateKeywords = [
    'change to', 'update to', 'move to', 'moved to', 'shift to',
    'reschedule', 'postpone to', 'delay to', 'push to',
    'new time', 'new date', 'different time', 'different date',
    'instead of', 'actually at', 'correction',
  ];
  if (updateKeywords.some(k => lower.includes(k))) {
    return { event_type: 'update_event', confidence: 0.65 };
  }

  // Time patterns (regex) - REQUIRED for event classification
  const specificTimePatterns = [
    /\d{1,2}[:\.\-]\d{2}\s*(am|pm)?/i,           // 10:30, 10.30 AM
    /\d{1,2}\s*(am|pm|a\.m|p\.m)/i,              // 10am, 10 pm
    /\d{1,2}\s*o'?clock/i,                        // 3 o'clock
    /\d{1,2}\s*baje/i,                            // 3 baje (Hindi/Gujarati)
    /\b(kal|tomorrow|parso)\s+(ko|at)?\s*\d/i,   // kal 3 baje, tomorrow at 5
    /\b(today|aaj|aaje)\s+(at|ko)?\s*\d/i,       // today at 3
    /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d{1,2}/i, // Dec 25
    /\d{1,2}\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i, // 25 Dec
    /\d{1,2}\/\d{1,2}/,                           // 12/25
    /deadline.*(today|tomorrow|kal|parso|\d)/i,   // deadline tomorrow
    /due.*(today|tomorrow|kal|parso|\d)/i,        // due tomorrow
  ];
  
  const hasSpecificTime = specificTimePatterns.some(p => p.test(lower));
  
  // Event keywords need to be paired with time for new_event
  const eventKeywords = [
    'meeting', 'call', 'appointment', 'deadline', 'due',
    'remind', 'reminder', 'schedule',
  ];
  
  const hasEventKeyword = eventKeywords.some(k => lower.includes(k));

  // ONLY classify as new_event if there's a SPECIFIC time/date
  if (hasSpecificTime) {
    if (hasEventKeyword) {
      return { event_type: 'new_event', confidence: 0.75 };
    }
    // Has time but no event word - could be update or new
    return { event_type: 'new_event', confidence: 0.55 };
  }
  
  // Has event keyword but NO specific time - NOT an event (just a vague request)
  // This is the key change - we don't create events for vague requests

  return { event_type: 'irrelevant', confidence: 0.7 };
}

export default { classifyMessage };
