/**
 * Context Builder Module
 * 
 * Aggregates conversation context for LLM extraction.
 * Fetches recent messages from the same chat.
 * Includes sender/receiver context for proper event attribution.
 * 
 * ENHANCED WITH SEMANTIC CONTEXT:
 * - Finds semantically similar past messages
 * - Includes examples of successful event extractions
 * - Provides richer context for extraction accuracy
 */

import { StoredMessage, MessageContext } from '../types/index.js';
import { getDatabase, getContactName } from '../database/sqlite.js';
import { countTokens } from './tokenCompressor.js';
import logger from '../utils/logger.js';
import { findSimilarMessages, initSemanticSearch } from '../vector/semanticSearch.js';

const CONTEXT_WINDOW_SIZE = 10; // Number of recent messages to include

// The user's identity (the person using this system)
const USER_IDENTITY = 'Me'; // Messages from the user are marked as is_from_me=1

export interface EnrichedContext extends MessageContext {
  currentMessage: StoredMessage;
  sender: string;
  senderIsMe: boolean;
  chatParticipants: string[];
  contactName: string | null;
  semanticExamples?: Array<{
    content: string;
    classification: string;
    similarity: number;
    eventId?: string;
  }>;
}

/**
 * Builds enriched context from recent messages in the chat
 * 
 * ENHANCED: Optionally includes semantically similar past messages
 * that led to successful event extractions
 */
export async function buildContext(
  currentMessage: StoredMessage,
  windowSize: number = CONTEXT_WINDOW_SIZE,
  includeSemanticExamples: boolean = true
): Promise<EnrichedContext> {
  logger.debug('Building context', {
    messageId: currentMessage.id,
    chatId: currentMessage.chat_id,
    windowSize,
    includeSemanticExamples,
  });

  const db = getDatabase();
  
  // Get contact info for this chat (uses phone number as fallback)
  const contactName = getContactName(currentMessage.chat_id);
  
  // Get recent messages from the same chat
  const recentMessages = await db.getRecentMessages(currentMessage.chat_id, windowSize);
  
  // Make sure current message is included
  const messageExists = recentMessages.some(m => m.id === currentMessage.id);
  if (!messageExists) {
    recentMessages.push(currentMessage);
  }

  // Sort by timestamp (oldest first for context)
  recentMessages.sort((a, b) => a.timestamp - b.timestamp);

  // Extract unique participants from chat history
  const participants = new Set<string>();
  for (const msg of recentMessages) {
    if (msg.is_from_me === true) {
      participants.add(USER_IDENTITY);
    } else if (msg.sender) {
      participants.add(msg.sender);
    }
  }
  const chatParticipants = Array.from(participants);

  // Accurate token count using tiktoken (per RULES.md)
  const totalContent = recentMessages.map(m => `[${m.sender}]: ${m.content}`).join('\n');
  const tokenCount = countTokens(totalContent);

  // Determine sender info (use contact name with phone fallback, never 'Unknown')
  const sender = currentMessage.is_from_me === true 
    ? USER_IDENTITY 
    : (currentMessage.sender || getContactName(currentMessage.chat_id));
  const senderIsMe = currentMessage.is_from_me === true;

  // Get semantic examples if requested
  let semanticExamples: EnrichedContext['semanticExamples'] = [];
  if (includeSemanticExamples) {
    try {
      await initSemanticSearch();
      const similarMessages = await findSimilarMessages(currentMessage.content, 3, 0.6, true);
      
      semanticExamples = similarMessages.map(m => ({
        content: m.content,
        classification: m.classification || 'unknown',
        similarity: m.similarity,
        eventId: m.eventId,
      }));
      
      if (semanticExamples.length > 0) {
        logger.debug('Found semantic examples for context', {
          count: semanticExamples.length,
          topSimilarity: semanticExamples[0]?.similarity,
        });
      }
    } catch (error) {
      logger.warn('Failed to get semantic examples', { error });
    }
  }

  logger.debug('Context built', {
    messageCount: recentMessages.length,
    tokenCount,
    sender,
    senderIsMe,
    participants: chatParticipants,
    semanticExamplesCount: semanticExamples.length,
  });

  return {
    messages: recentMessages,
    compressed: false,
    tokenCount,
    currentMessage,
    sender,
    senderIsMe,
    chatParticipants,
    contactName,
    semanticExamples,
  };
}

/**
 * Formats enriched context for LLM input
 * Includes sender/receiver info, participants, and marks the current message
 * 
 * ENHANCED: Includes semantic examples from similar past messages
 * 
 * IMPORTANT: Each chat is isolated. Messages from different chats are NEVER mixed.
 * The chat_id uniquely identifies the conversation.
 */
export function formatContextForLLM(context: EnrichedContext): string {
  if (context.compressed && context.compressedContent) {
    return context.compressedContent;
  }

  const lines: string[] = [];
  
  // Add context header with clear chat identification
  lines.push('=== CHAT CONTEXT ===');
  lines.push(`Chat ID: ${context.currentMessage.chat_id}`);
  lines.push(`Chat with: ${context.contactName || 'Unknown Contact'}`);
  lines.push(`Participants: ${context.chatParticipants.join(', ')}`);
  lines.push('');
  lines.push('NOTE: This is an isolated conversation. All messages below are from THIS chat only.');
  lines.push('Messages from other chats are NOT included.');
  
  // Add semantic examples if available
  if (context.semanticExamples && context.semanticExamples.length > 0) {
    lines.push('');
    lines.push('=== SIMILAR PAST MESSAGES (for reference) ===');
    lines.push('These similar messages led to successful event extractions:');
    for (const example of context.semanticExamples) {
      lines.push(`- "${example.content.slice(0, 100)}" (classified as: ${example.classification}, similarity: ${(example.similarity * 100).toFixed(0)}%)`);
    }
  }
  
  lines.push('');
  lines.push('=== MESSAGE HISTORY (Last 10 messages from this chat) ===');
  
  // Format messages with clear direction indicator
  const messages = context.messages;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isFromMe = m.is_from_me === true;
    const sender = isFromMe ? 'Me' : (m.sender || context.contactName);
    const time = new Date(m.timestamp * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const direction = isFromMe ? `Me → ${context.contactName}` : `${context.contactName} → Me`;
    const isLast = i === messages.length - 1;
    
    if (isLast) {
      lines.push('');
      lines.push('=== CURRENT MESSAGE (EXTRACT EVENT FROM THIS) ===');
      lines.push(`Direction: ${direction}`);
      lines.push(`Sender: ${sender}${isFromMe ? ' (ME - the user of this system)' : ''}`);
      lines.push(`Time (IST): ${time}`);
      lines.push(`Content: ${m.content}`);
    } else {
      lines.push(`[${time}] ${direction}: ${m.content}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Extracts just the current message content
 */
export function getCurrentMessageContent(context: MessageContext): string {
  if (context.messages.length === 0) return '';
  return context.messages[context.messages.length - 1].content;
}

export default { buildContext, formatContextForLLM, getCurrentMessageContent };
