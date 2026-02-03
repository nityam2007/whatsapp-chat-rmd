/**
 * Context Matcher Service
 * 
 * Uses Gemini's massive context window (1M tokens) for intelligent
 * context matching between incoming messages and pending events.
 * 
 * This is the "smart" matching that goes beyond simple keyword matching.
 */

import OpenAI from 'openai';
import { StoredMessage, StoredEvent } from '../shared/types.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Gemini client (OpenAI compatible)
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

export interface SmartMatch {
  event: StoredEvent;
  matchedKeywords: string[];
  matchType: 'smart';
  confidence: number;
  reason: string;
}

/**
 * Use Gemini to intelligently match incoming messages against pending events
 * Leverages the 1M token context window for comprehensive understanding
 */
export async function smartContextMatch(
  message: StoredMessage,
  pendingEvents: StoredEvent[]
): Promise<SmartMatch[]> {
  if (!config.geminiApiKey || pendingEvents.length === 0) {
    return [];
  }

  try {
    const client = getGeminiClient();
    
    // Build the context with all pending events
    const eventsContext = pendingEvents.map(e => ({
      id: e.id,
      title: e.title,
      context_tags: e.context_tags || [],
      location: e.location,
      condition: e.condition_value,
      created_by: e.created_by,
      chat_id: e.chat_id,
      source: e.source_message_content?.slice(0, 200),
    }));

    const prompt = `You are an intelligent context matcher for a WhatsApp reminder system.

## Your Task
Analyze the incoming message and check if it indicates the user is in a context where any pending task should be reminded.

## Pending Tasks/Events:
${JSON.stringify(eventsContext, null, 2)}

## Incoming Message:
From: ${message.sender}
Content: "${message.content}"
Time: ${new Date(message.timestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

## Matching Rules:
1. **Location Match**: If message mentions a location that matches a task's location/context
   - Example: "Just reached Goa" should trigger task with location="goa" or context_tags=["goa"]
   
2. **Activity Match**: If message indicates an activity related to a pending task
   - Example: "Going shopping" should trigger shopping-related tasks
   - Example: "On my way home" should trigger "bring X on way home" tasks
   
3. **Contextual Inference**: Use common sense to infer connections
   - Example: "At the airport" + task "Get duty-free chocolate" = match
   - Example: "Meeting with John" + task "Ask John about project" = match

4. **Do NOT match if**:
   - The message is casual conversation with no actionable context
   - The connection is too weak or speculative
   - The task has already been completed (status check)

## Response Format (JSON only):
Return a JSON array of matches. Each match should have:
{
  "event_id": "string",
  "matched_keywords": ["string"],
  "confidence": 0.0 to 1.0,
  "reason": "brief explanation"
}

Return empty array [] if no matches found.
Only return the JSON array, no other text.`;

    const response = await client.chat.completions.create({
      model: config.geminiModel || 'gemini-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const content = response.choices[0]?.message?.content?.trim() || '[]';
    
    // Parse the response
    let matches: Array<{
      event_id: string;
      matched_keywords: string[];
      confidence: number;
      reason: string;
    }> = [];

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        matches = JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      logger.warn('Failed to parse smart match response', { content, error: parseError });
      return [];
    }

    // Convert to SmartMatch format
    const smartMatches: SmartMatch[] = [];
    
    for (const match of matches) {
      if (match.confidence < 0.5) continue; // Skip low confidence matches
      
      const event = pendingEvents.find(e => e.id === match.event_id);
      if (!event) continue;
      
      smartMatches.push({
        event,
        matchedKeywords: match.matched_keywords || [],
        matchType: 'smart',
        confidence: match.confidence,
        reason: match.reason,
      });
    }

    logger.info('Smart context matching completed', {
      messageId: message.id,
      pendingCount: pendingEvents.length,
      matchCount: smartMatches.length,
    });

    return smartMatches;
  } catch (error) {
    logger.error('Smart context matching failed', { error, messageId: message.id });
    return [];
  }
}

/**
 * Extract context tags from a message using Gemini
 * Used when creating new events to populate context_tags
 */
export async function extractContextTags(
  messageContent: string,
  eventTitle: string
): Promise<{
  context_tags: string[];
  location: string | null;
  trigger_keywords: string[];
}> {
  if (!config.geminiApiKey) {
    // Fallback to simple extraction
    return simpleContextExtraction(messageContent, eventTitle);
  }

  try {
    const client = getGeminiClient();
    
    const prompt = `Extract context tags from this WhatsApp message that created an event/reminder.

Message: "${messageContent}"
Event Title: "${eventTitle}"

Extract:
1. **context_tags**: All relevant keywords (locations, items, activities, people)
2. **location**: Primary location if mentioned (city, place, or contextual like "office", "home")
3. **trigger_keywords**: Keywords that should trigger a proactive reminder
   - For "Get cashew from Goa" → trigger_keywords: ["goa", "reached goa", "in goa"]
   - For "Bring milk on way home" → trigger_keywords: ["way home", "going home", "reaching home"]

Return JSON only:
{
  "context_tags": ["tag1", "tag2"],
  "location": "location or null",
  "trigger_keywords": ["keyword1", "keyword2"]
}`;

    const response = await client.chat.completions.create({
      model: config.geminiModel || 'gemini-2.0-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content?.trim() || '{}';
    
    // Parse the response
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          context_tags: parsed.context_tags || [],
          location: parsed.location || null,
          trigger_keywords: parsed.trigger_keywords || [],
        };
      }
    } catch {
      logger.warn('Failed to parse context extraction response', { content });
    }

    return simpleContextExtraction(messageContent, eventTitle);
  } catch (error) {
    logger.error('Context tag extraction failed', { error });
    return simpleContextExtraction(messageContent, eventTitle);
  }
}

/**
 * Simple fallback context extraction (no LLM)
 */
function simpleContextExtraction(
  messageContent: string,
  eventTitle: string
): {
  context_tags: string[];
  location: string | null;
  trigger_keywords: string[];
} {
  const combined = `${messageContent} ${eventTitle}`.toLowerCase();
  
  // Common locations
  const locations = [
    'goa', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'pune',
    'office', 'home', 'ghar', 'mall', 'market', 'station', 'airport',
    'shop', 'store', 'hospital', 'school', 'college',
  ];
  
  const context_tags: string[] = [];
  let location: string | null = null;
  const trigger_keywords: string[] = [];
  
  // Extract locations
  for (const loc of locations) {
    if (combined.includes(loc)) {
      context_tags.push(loc);
      if (!location) location = loc;
      trigger_keywords.push(loc);
      trigger_keywords.push(`reached ${loc}`);
      trigger_keywords.push(`in ${loc}`);
    }
  }
  
  // Extract action items
  const actionPatterns = [
    /bring\s+(\w+)/gi,
    /get\s+(\w+)/gi,
    /buy\s+(\w+)/gi,
    /pick\s+up?\s*(\w+)/gi,
  ];
  
  for (const pattern of actionPatterns) {
    const matches = combined.matchAll(pattern);
    for (const match of matches) {
      if (match[1] && match[1].length > 2) {
        context_tags.push(match[1]);
      }
    }
  }
  
  // Check for "on way" patterns
  if (/on\s*(your|my|the)?\s*way/i.test(combined)) {
    trigger_keywords.push('on way', 'way home', 'going home', 'coming home');
  }
  
  return {
    context_tags: [...new Set(context_tags)],
    location,
    trigger_keywords: [...new Set(trigger_keywords)],
  };
}

export default {
  smartContextMatch,
  extractContextTags,
};
