/**
 * Context Builder Module
 * 
 * Aggregates conversation context for LLM extraction.
 * Fetches recent messages from the same chat.
 * Includes sender/receiver context for proper event attribution.
 */

import { StoredMessage, MessageContext } from '../types/index.js';
import { getDatabase, getContactById } from '../database/sqlite.js';
import { countTokens } from './tokenCompressor.js';
import logger from '../utils/logger.js';

const CONTEXT_WINDOW_SIZE = 10; // Number of recent messages to include

// The user's identity (the person using this system)
const USER_IDENTITY = 'Me'; // Messages from the user are marked as is_from_me=1

export interface EnrichedContext extends MessageContext {
  currentMessage: StoredMessage;
  sender: string;
  senderIsMe: boolean;
  chatParticipants: string[];
  contactName: string | null;
}

/**
 * Builds enriched context from recent messages in the chat
 */
export async function buildContext(
  currentMessage: StoredMessage,
  windowSize: number = CONTEXT_WINDOW_SIZE
): Promise<EnrichedContext> {
  logger.debug('Building context', {
    messageId: currentMessage.id,
    chatId: currentMessage.chat_id,
    windowSize,
  });

  const db = getDatabase();
  
  // Get contact info for this chat
  const contact = getContactById(currentMessage.chat_id);
  const contactName = contact?.name || null;
  
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

  // Determine sender info
  const sender = currentMessage.is_from_me === true ? USER_IDENTITY : (currentMessage.sender || 'Unknown');
  const senderIsMe = currentMessage.is_from_me === true;

  logger.debug('Context built', {
    messageCount: recentMessages.length,
    tokenCount,
    sender,
    senderIsMe,
    participants: chatParticipants,
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
  };
}

/**
 * Formats enriched context for LLM input
 * Includes sender/receiver info, participants, and marks the current message
 */
export function formatContextForLLM(context: EnrichedContext): string {
  if (context.compressed && context.compressedContent) {
    return context.compressedContent;
  }

  const lines: string[] = [];
  
  // Add context header with participant info
  lines.push('=== CHAT CONTEXT ===');
  lines.push(`Chat with: ${context.contactName || 'Unknown'}`);
  lines.push(`Participants in this conversation: ${context.chatParticipants.join(', ')}`);
  lines.push(`Current message sender: ${context.sender}${context.senderIsMe ? ' (this is ME, the user of this system)' : ''}`);
  lines.push('');
  lines.push('=== MESSAGE HISTORY ===');
  
  // Format messages
  const messages = context.messages;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isFromMe = m.is_from_me === true;
    const sender = isFromMe ? 'Me' : (m.sender || 'Unknown');
    const time = new Date(m.timestamp * 1000).toISOString();
    const isLast = i === messages.length - 1;
    
    if (isLast) {
      lines.push('');
      lines.push('=== CURRENT MESSAGE (EXTRACT EVENT FROM THIS) ===');
      lines.push(`Sender: ${sender}${isFromMe ? ' (ME - the user)' : ''}`);
      lines.push(`Time: ${time}`);
      lines.push(`Content: ${m.content}`);
    } else {
      lines.push(`[${time}] ${sender}: ${m.content}`);
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
