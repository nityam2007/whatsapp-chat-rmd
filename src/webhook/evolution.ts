/**
 * Evolution API Webhook Handler
 * 
 * Handles incoming webhooks from Evolution API (WhatsApp).
 * Processes both incoming and outgoing messages.
 * Extracts contact names and stores them for AI context.
 * 
 * DATA COLLECTION:
 * - ALL messages are stored (even if not event-related)
 * - Pipeline results are saved at each stage
 * - Deduplication prevents double-processing of same message
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { 
  EvolutionWebhookPayload, 
  StoredMessage, 
  PipelineState 
} from '../types/index.js';
import { processMessage } from '../pipeline/index.js';
import { 
  upsertContact, 
  formatISTDate, 
  messageExists,
  getEventBySourceMessage,
} from '../database/sqlite.js';
import logger from '../utils/logger.js';
import { 
  logWebhook, 
  logSummary, 
  logError, 
  PipelineLogContext 
} from '../utils/pipelineLogger.js';

export const webhookRouter = Router();

// Pipeline state tracking (in-memory for quick status checks)
const pipelineStates: Map<string, PipelineState> = new Map();

// Track recently processed messages to prevent rapid-fire duplicates
const recentlyProcessed: Map<string, number> = new Map();
const DEDUP_WINDOW_MS = 5000; // 5 second window for deduplication

// Configuration
const PROCESS_OWN_MESSAGES = process.env.PROCESS_OWN_MESSAGES !== 'false'; // Default: true
const SKIP_GROUP_MESSAGES = process.env.SKIP_GROUP_MESSAGES !== 'false'; // Default: true

/**
 * Cleanup old entries from recentlyProcessed map
 */
function cleanupRecentlyProcessed(): void {
  const now = Date.now();
  for (const [id, timestamp] of recentlyProcessed.entries()) {
    if (now - timestamp > DEDUP_WINDOW_MS * 2) {
      recentlyProcessed.delete(id);
    }
  }
}

// Cleanup every minute
setInterval(cleanupRecentlyProcessed, 60000);

/**
 * Extracts message content from Evolution API payload
 */
function extractMessageContent(data: EvolutionWebhookPayload['data']): string | null {
  if (data.message.conversation) {
    return data.message.conversation;
  }
  if (data.message.extendedTextMessage?.text) {
    return data.message.extendedTextMessage.text;
  }
  return null;
}

/**
 * Check if message is from a group
 */
function isGroupMessage(chatId: string): boolean {
  return chatId.includes('@g.us');
}

/**
 * Extracts phone number from WhatsApp JID (chat_id)
 * e.g., "919664833459@s.whatsapp.net" -> "+919664833459"
 */
function extractPhoneFromJid(jid: string): string {
  const phone = jid.split('@')[0];
  return phone ? `+${phone}` : jid;
}

/**
 * Gets display name with phone number fallback
 * Priority: pushName > phone number (never 'Unknown')
 */
function getDisplayName(pushName: string | undefined, chatId: string, isFromMe: boolean): string {
  if (isFromMe) return 'Me';
  if (pushName && pushName.trim()) return pushName.trim();
  return extractPhoneFromJid(chatId);
}

/**
 * Converts Evolution API payload to StoredMessage
 * Also stores/updates contact information
 */
function payloadToMessage(payload: EvolutionWebhookPayload): StoredMessage | null {
  const content = extractMessageContent(payload.data);
  
  if (!content) {
    logger.debug('No text content in message', { messageType: payload.data.messageType });
    return null;
  }

  // Extract sender info
  const chatId = payload.data.key.remoteJid;
  const isFromMe = payload.data.key.fromMe;
  const senderName = getDisplayName(payload.data.pushName, chatId, isFromMe);
  // const _senderId = payload.data.key.participant || chatId;  // Available if needed
  
  // Check if group message should be skipped
  if (SKIP_GROUP_MESSAGES && isGroupMessage(chatId)) {
    logger.debug('Skipping group message', { chatId });
    return null;
  }
  
  // Store/update contact in database
  // We always need to ensure the contact exists for the chat_id (for foreign key constraint)
  try {
    // For own messages, get contact name from pushName or use phone; for incoming, use sender name
    const contactName = isFromMe 
      ? (payload.data.pushName?.trim() || extractPhoneFromJid(chatId)) 
      : senderName;
    upsertContact(chatId, contactName);
    logger.debug('Contact upserted', { chatId, contactName, isFromMe });
  } catch (error) {
    logger.warn('Failed to upsert contact', { error, chatId });
  }

  // Format timestamp in IST for logging
  const timestampIST = formatISTDate(payload.data.messageTimestamp * 1000);
  logger.debug('Message received', { 
    from: senderName, 
    chatId, 
    timestampIST,
    isFromMe,
    contentPreview: content.substring(0, 50) 
  });

  return {
    id: payload.data.key.id,
    chat_id: chatId,
    sender: senderName,
    content,
    timestamp: payload.data.messageTimestamp,
    processed: false,
    created_at: new Date().toISOString(),
  };
}

/**
 * Main webhook endpoint for Evolution API
 */
webhookRouter.post('/evolution', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const payload = req.body as EvolutionWebhookPayload;
    
    // Validate basic payload structure
    if (!payload || !payload.event) {
      logger.warn('Invalid webhook payload');
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    // Only process message events
    if (payload.event !== 'messages.upsert') {
      logger.debug('Ignoring non-message event', { event: payload.event });
      res.status(200).json({ status: 'ignored', event: payload.event });
      return;
    }

    // Validate message payload has required fields
    if (!payload.data || !payload.data.key) {
      logger.warn('Invalid message payload - missing data.key');
      res.status(400).json({ error: 'Invalid message payload' });
      return;
    }

    const messageId = payload.data.key.id;
    const isFromMe = payload.data.key.fromMe;
    const chatId = payload.data.key.remoteJid;

    // =====================================
    // Rapid-fire deduplication (in-memory)
    // =====================================
    if (recentlyProcessed.has(messageId)) {
      logger.debug('Duplicate webhook ignored (rapid-fire)', { messageId });
      res.status(200).json({ status: 'ignored', reason: 'duplicate_rapid' });
      return;
    }
    recentlyProcessed.set(messageId, Date.now());

    // =====================================
    // Check if message already fully processed (database check)
    // =====================================
    if (messageExists(messageId)) {
      const existingEvent = getEventBySourceMessage(messageId);
      if (existingEvent) {
        logger.debug('Message already processed with event', { messageId, eventId: existingEvent.id });
        res.status(200).json({ 
          status: 'already_processed', 
          messageId,
          eventId: existingEvent.id,
        });
        return;
      }
      // Message exists but no event - allow reprocessing
      logger.debug('Message exists without event, allowing reprocessing', { messageId });
    }

    // Skip own messages if configured
    if (!PROCESS_OWN_MESSAGES && isFromMe) {
      logger.debug('Ignoring own message (disabled)');
      res.status(200).json({ status: 'ignored', reason: 'own_message' });
      return;
    }

    // Skip group messages if configured
    if (SKIP_GROUP_MESSAGES && isGroupMessage(chatId)) {
      logger.debug('Ignoring group message (disabled)', { chatId });
      res.status(200).json({ status: 'ignored', reason: 'group_message' });
      return;
    }

    // Convert to StoredMessage
    const message = payloadToMessage(payload);
    
    if (!message) {
      res.status(200).json({ status: 'ignored', reason: 'no_text_content' });
      return;
    }

    // Create pipeline log context
    const logCtx: PipelineLogContext = {
      messageId: message.id,
      sender: message.sender,
      chatId: message.chat_id,
      content: message.content,
    };

    // Log webhook received
    logWebhook(logCtx, payload.event, {
      isFromMe,
      messageType: payload.data.messageType,
      timestampIST: formatISTDate(message.timestamp * 1000),
    });

    logger.info('Processing webhook message', {
      messageId: message.id,
      chatId: message.chat_id,
      sender: message.sender,
      isFromMe,
      contentLength: message.content.length,
      timestampIST: formatISTDate(message.timestamp * 1000),
    });

    // Initialize pipeline state
    const state: PipelineState = {
      messageId: message.id,
      stage: 'received',
      startedAt: startTime,
    };
    pipelineStates.set(message.id, state);

    // Process message through pipeline (async)
    processMessage(message)
      .then(result => {
        state.stage = result ? 'completed' : 'dropped';
        state.completedAt = Date.now();
        const duration = state.completedAt - startTime;
        
        logger.info('Pipeline completed', {
          messageId: message.id,
          duration,
          result: result ? 'event_created' : 'dropped',
        });

        // Log summary
        logSummary(
          logCtx, 
          result ? 'success' : 'dropped',
          result 
            ? `Event created: ${result.title || 'Untitled'} (${result.id})`
            : 'No event extracted - message dropped'
        );
      })
      .catch(error => {
        state.stage = 'error';
        state.error = String(error);
        state.completedAt = Date.now();
        
        logger.error('Pipeline error', { error, messageId: message.id });
        logError(logCtx, 'pipeline', error);
        logSummary(logCtx, 'error', `Pipeline failed: ${error.message || error}`);
      });

    // Return immediately (async processing)
    res.status(200).json({ 
      status: 'processing',
      messageId: message.id,
    });

  } catch (error) {
    logger.error('Webhook handler error', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Health check endpoint
 */
webhookRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      processOwnMessages: PROCESS_OWN_MESSAGES,
      skipGroupMessages: SKIP_GROUP_MESSAGES,
    },
  });
});

/**
 * Pipeline status endpoint
 */
webhookRouter.get('/status/:messageId', (req: Request, res: Response) => {
  const messageId = req.params.messageId as string;
  const state = pipelineStates.get(messageId);
  
  if (!state) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  
  res.json(state);
});

/**
 * Test endpoint for manual message submission
 */
webhookRouter.post('/test', async (req: Request, res: Response) => {
  const { content, chat_id, sender } = req.body;
  
  if (!content) {
    res.status(400).json({ error: 'Content is required' });
    return;
  }

  const chatId = chat_id || 'test-chat@s.whatsapp.net';
  const senderName = sender || 'Test User';

  // Upsert contact for test messages too
  try {
    upsertContact(chatId, senderName);
  } catch (error) {
    logger.warn('Failed to upsert test contact', { error, chatId });
  }

  const message: StoredMessage = {
    id: uuidv4(),
    chat_id: chatId,
    sender: senderName,
    content,
    timestamp: Math.floor(Date.now() / 1000),
    processed: false,
    created_at: new Date().toISOString(),
  };

  // Create pipeline log context
  const logCtx: PipelineLogContext = {
    messageId: message.id,
    sender: message.sender,
    chatId: message.chat_id,
    content: message.content,
  };

  // Log webhook
  logWebhook(logCtx, 'test.message', { source: 'test_endpoint' });

  logger.info('Processing test message', { 
    messageId: message.id, 
    sender: senderName,
    timestampIST: formatISTDate(message.timestamp * 1000),
  });

  try {
    const result = await processMessage(message);
    
    // Log summary
    logSummary(
      logCtx,
      result ? 'success' : 'dropped',
      result 
        ? `Event created: ${result.title || 'Untitled'}`
        : 'No event extracted'
    );
    
    res.json({
      status: 'completed',
      messageId: message.id,
      sender: senderName,
      result: result || 'dropped',
      timestampIST: formatISTDate(message.timestamp * 1000),
    });
  } catch (error) {
    logError(logCtx, 'test_pipeline', error);
    logSummary(logCtx, 'error', `Test failed: ${error}`);
    
    logger.error('Test message processing error', { error });
    res.status(500).json({ error: 'Processing failed' });
  }
});

export default webhookRouter;
