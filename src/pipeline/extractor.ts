/**
 * Big LLM Extractor Module
 * 
 * Uses a larger LLM for structured event data extraction.
 * Outputs ONLY the defined JSON schema.
 * 
 * AUTO-LEARNING: All successful extractions are logged to the database
 * for pattern learning. The PatternLearner service analyzes these logs
 * to create new regex patterns that can skip LLM in the future.
 */

import OpenAI from 'openai';
import { ExtractedEvent, EventType } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Callback for logging extractions (set by the pipeline)
let extractionLogCallback: ((data: {
  messageId: string;
  rawMessage: string;
  eventType: string;
  extractedTitle: string | null;
  extractedTime: string | null;
  extractedDate: string | null;
  extractedParticipants: string[];
  llmModel: string;
  llmTokensUsed: number;
  llmLatencyMs: number;
  confidence: number;
  ruleEngineTried: boolean;
  ruleEngineConfidence: number;
}) => void) | null = null;

/**
 * Set the callback for logging LLM extractions (called by pipeline)
 */
export function setExtractionLogCallback(callback: typeof extractionLogCallback): void {
  extractionLogCallback = callback;
}

/**
 * Log an LLM extraction for pattern learning
 */
function logExtraction(data: {
  messageId: string;
  rawMessage: string;
  result: ExtractedEvent;
  tokensUsed: number;
  latencyMs: number;
  ruleEngineTried: boolean;
  ruleEngineConfidence: number;
}): void {
  if (!extractionLogCallback) return;
  
  try {
    extractionLogCallback({
      messageId: data.messageId,
      rawMessage: data.rawMessage,
      eventType: data.result.event_type,
      extractedTitle: data.result.title,
      extractedTime: data.result.start_time,
      extractedDate: data.result.start_time ? data.result.start_time.split('T')[0] : null,
      extractedParticipants: data.result.participants || [],
      llmModel: config.openaiModelBig,
      llmTokensUsed: data.tokensUsed,
      llmLatencyMs: data.latencyMs,
      confidence: data.result.confidence,
      ruleEngineTried: data.ruleEngineTried,
      ruleEngineConfidence: data.ruleEngineConfidence,
    });
  } catch (err) {
    logger.warn('Failed to log extraction for pattern learning', { error: err });
  }
}

const EXTRACTION_PROMPT = `You are a deterministic event extraction system. Extract structured event data from the conversation context.

TIMEZONE: All times mentioned by the user are in IST (India Standard Time, UTC+5:30).
When outputting times, convert to UTC ISO-8601 format but interpret user's times as IST.

Example: If user says "8 PM today" and today is Monday Feb 2nd 2026 in IST:
- User means 8 PM IST = 20:00 IST
- Convert to UTC: 20:00 IST - 5:30 = 14:30 UTC
- Output: "2026-02-02T14:30:00.000Z"

CURRENT REFERENCE TIME:
- UTC: {{CURRENT_TIME_UTC}}
- IST: {{CURRENT_TIME_IST}}
- Day: {{CURRENT_DAY}}
- Date: {{CURRENT_DATE}}

RELATIVE TIME INTERPRETATION:
- "today" = {{TODAY_DATE}}
- "tomorrow" = {{TOMORROW_DATE}}
- "Thursday" = next Thursday from {{CURRENT_DATE}}

SENDER/RECEIVER CONTEXT:
The context includes information about who sent the message and who the participants are.
- "Me" = The user of this system (the person who receives reminders)
- Other names = People the user is chatting with

When extracting events:
- If Akshat says "Meeting with Rohan at 8 PM", the event is between Akshat and Rohan (or the user if the user is Akshat)
- Include all relevant participants in the "participants" field
- The "created_by" field should be the message sender

EXISTING EVENTS SECTION:
If the context includes an "EXISTING EVENTS" section, these are events that may be referenced by the current message.
- If user says "cancel the meeting" or "cancel meeting with John", identify which existing event they mean
- Use the Event ID from existing events when the message is about modifying/canceling them
- For update_event, the event being updated should match one of the existing events

EVENT TYPE DETECTION:
- new_event: A completely new event/meeting/appointment being scheduled
- update_event: User wants to change time, date, location, or details of an EXISTING event
  - Keywords: reschedule, postpone, move to, change time, new time, new date, delay
  - Example: "Can we move the meeting to 3pm?" → update_event
  - Example: "Let's reschedule to tomorrow" → update_event
  - Example: "Cancel the meeting" → update_event (with status change to cancelled implied)
- signal_event: A trigger/condition for a pending event
- irrelevant: Casual chat with no scheduling information

RULES:
- Output ONLY valid JSON
- NO prose, NO explanations, NO markdown
- If data is missing, set to null
- If confidence is low, set confidence < 0.5
- Times must be ISO-8601 UTC format (ending in Z)
- Interpret ALL user times as IST, output as UTC
- DO NOT guess or invent data
- CRITICAL: Extract from the CURRENT MESSAGE section only
- Use MESSAGE HISTORY only for context (understanding references)
- Extract participants from the message content (names mentioned)
- The message sender (from "Sender:" field) should be in created_by
- For cancel messages, use update_event with the title from the matched existing event

OUTPUT SCHEMA (respond with EXACTLY this structure):
{
  "event_type": "new_event | update_event | signal_event | irrelevant",
  "title": "string | null",
  "start_time": "ISO-8601-UTC | null",
  "end_time": "ISO-8601-UTC | null",
  "condition": {
    "type": "location | time | dependency | null",
    "value": "string | null"
  },
  "participants": ["array of participant names mentioned in the event"],
  "created_by": "name of the message sender",
  "confidence": 0.0
}

CONVERSATION CONTEXT:
`;

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openaiApiKey,
    });
  }
  return openaiClient;
}

/**
 * Metadata for logging extractions (used by pattern learner)
 */
export interface ExtractionMetadata {
  messageId: string;
  rawMessage: string;
  ruleEngineTried?: boolean;
  ruleEngineConfidence?: number;
}

/**
 * Extracts structured event data from context
 */
export async function extractEvent(
  context: string, 
  metadata?: ExtractionMetadata,
  retryCount: number = 0
): Promise<ExtractedEvent> {
  logger.debug('Extracting event', { contextLength: context.length, retryCount });

  // If no API key, use fallback
  if (!config.openaiApiKey) {
    logger.warn('No OpenAI API key configured, using fallback extraction');
    return createEmptyEvent();
  }

  const startTime = Date.now();
  
  try {
    const client = getOpenAIClient();
    
    // Get current time in both UTC and IST
    const now = new Date();
    const utcTime = now.toISOString();
    
    // Get IST time
    const istOptions: Intl.DateTimeFormatOptions = {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      weekday: 'long',
    };
    const istFormatter = new Intl.DateTimeFormat('en-IN', istOptions);
    const istParts = istFormatter.formatToParts(now);
    
    const getIstPart = (type: string) => istParts.find(p => p.type === type)?.value || '';
    
    const currentTimeIST = `${getIstPart('day')}/${getIstPart('month')}/${getIstPart('year')} ${getIstPart('hour')}:${getIstPart('minute')} ${getIstPart('dayPeriod')}`;
    const currentDay = getIstPart('weekday');
    const currentDate = `${getIstPart('day')}/${getIstPart('month')}/${getIstPart('year')}`;
    
    // Calculate today and tomorrow in IST
    const todayIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const tomorrowIST = new Date(todayIST);
    tomorrowIST.setDate(tomorrowIST.getDate() + 1);
    
    const formatDateShort = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
    
    const prompt = EXTRACTION_PROMPT
      .replace('{{CURRENT_TIME_UTC}}', utcTime)
      .replace('{{CURRENT_TIME_IST}}', currentTimeIST)
      .replace('{{CURRENT_DAY}}', currentDay)
      .replace('{{CURRENT_DATE}}', currentDate)
      .replace('{{TODAY_DATE}}', formatDateShort(todayIST))
      .replace('{{TOMORROW_DATE}}', formatDateShort(tomorrowIST))
      + context;
    
    const response = await client.chat.completions.create({
      model: config.openaiModelBig,
      messages: [
        {
          role: 'system',
          content: 'You are a JSON-only event extraction system. Never output anything except valid JSON. All user times are in IST (UTC+5:30). Output times in UTC.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });

    const responseText = response.choices[0]?.message?.content?.trim() || '';
    const tokensUsed = response.usage?.total_tokens || 0;
    const latencyMs = Date.now() - startTime;
    
    // Parse and validate response
    const result = parseExtractionResponse(responseText);
    
    // Log for pattern learning (only for successful extractions)
    if (metadata && result.event_type !== 'irrelevant' && result.confidence >= 0.5) {
      logExtraction({
        messageId: metadata.messageId,
        rawMessage: metadata.rawMessage,
        result,
        tokensUsed,
        latencyMs,
        ruleEngineTried: metadata.ruleEngineTried ?? false,
        ruleEngineConfidence: metadata.ruleEngineConfidence ?? 0,
      });
    }
    
    logger.debug('Extraction result', {
      eventType: result.event_type,
      title: result.title,
      confidence: result.confidence,
      startTime: result.start_time,
      latencyMs,
      tokensUsed,
    });

    return result;
  } catch (error) {
    logger.error('Extraction error', { error, retryCount });
    
    // Retry once on failure
    if (retryCount === 0) {
      logger.info('Retrying extraction...');
      return extractEvent(context, metadata, 1);
    }
    
    return createEmptyEvent();
  }
}

/**
 * Parses and validates the LLM extraction response
 */
function parseExtractionResponse(response: string): ExtractedEvent {
  try {
    const parsed = JSON.parse(response);
    return validateAndNormalize(parsed);
  } catch {
    logger.warn('Failed to parse extraction response', { response });
    return createEmptyEvent();
  }
}

/**
 * Validates and normalizes the extracted event
 */
function validateAndNormalize(data: Record<string, unknown>): ExtractedEvent {
  const validTypes: EventType[] = ['new_event', 'update_event', 'signal_event', 'irrelevant'];
  
  // Validate event_type
  let eventType: EventType = 'irrelevant';
  if (typeof data.event_type === 'string' && validTypes.includes(data.event_type as EventType)) {
    eventType = data.event_type as EventType;
  }

  // Validate title
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;

  // Validate times
  const startTime = validateISOTime(data.start_time);
  const endTime = validateISOTime(data.end_time);

  // Validate condition
  const condition = validateCondition(data.condition);

  // Validate participants (array of strings)
  let participants: string[] = [];
  if (Array.isArray(data.participants)) {
    participants = data.participants
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map(p => p.trim());
  }

  // Validate created_by
  const createdBy = typeof data.created_by === 'string' && data.created_by.trim() 
    ? data.created_by.trim() 
    : null;

  // Validate confidence
  let confidence = 0.5;
  if (typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1) {
    confidence = data.confidence;
  }

  return {
    event_type: eventType,
    title,
    start_time: startTime,
    end_time: endTime,
    condition,
    participants,
    created_by: createdBy,
    confidence,
  };
}

/**
 * Validates ISO-8601 time format
 */
function validateISOTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  
  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  } catch {
    return null;
  }
}

/**
 * Validates condition object
 */
function validateCondition(value: unknown): ExtractedEvent['condition'] {
  const validConditionTypes = ['location', 'time', 'dependency', null];
  
  if (!value || typeof value !== 'object') {
    return { type: null, value: null };
  }

  const condition = value as Record<string, unknown>;
  
  let type: 'location' | 'time' | 'dependency' | null = null;
  if (validConditionTypes.includes(condition.type as string | null)) {
    type = condition.type as typeof type;
  }

  const conditionValue = typeof condition.value === 'string' ? condition.value : null;

  return { type, value: conditionValue };
}

/**
 * Creates an empty/default event
 */
function createEmptyEvent(): ExtractedEvent {
  return {
    event_type: 'irrelevant',
    title: null,
    start_time: null,
    end_time: null,
    condition: { type: null, value: null },
    participants: [],
    created_by: null,
    confidence: 0,
  };
}

export default { extractEvent, setExtractionLogCallback };
