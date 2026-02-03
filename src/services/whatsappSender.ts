/**
 * WhatsApp Sender Service
 * 
 * Sends WhatsApp messages via Evolution API.
 * Used for proactive reminders and context clarification.
 */

import { config } from '../config/index.js';
import logger from '../utils/logger.js';

interface SendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Sends a text message via WhatsApp (Evolution API)
 */
export async function sendWhatsAppMessage(
  chatId: string,
  message: string,
  instanceName?: string
): Promise<SendMessageResult> {
  const instance = instanceName || config.evolutionInstance || 'default';
  
  if (!config.evolutionApiUrl || !config.evolutionApiKey) {
    logger.warn('Evolution API not configured, skipping WhatsApp send', { chatId });
    return { success: false, error: 'Evolution API not configured' };
  }

  try {
    // Format the chat ID (add @s.whatsapp.net if needed)
    const formattedChatId = formatChatId(chatId);
    
    const url = `${config.evolutionApiUrl}/message/sendText/${instance}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': config.evolutionApiKey,
      },
      body: JSON.stringify({
        number: formattedChatId,
        text: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to send WhatsApp message', { 
        status: response.status, 
        error: errorText,
        chatId,
      });
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const result = await response.json() as { key?: { id?: string } };
    
    logger.info('WhatsApp message sent successfully', { 
      chatId, 
      messageId: result.key?.id,
      instance,
    });

    return { 
      success: true, 
      messageId: result.key?.id,
    };
  } catch (error) {
    logger.error('Error sending WhatsApp message', { error, chatId });
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Sends a proactive reminder message
 */
export async function sendProactiveReminderMessage(
  chatId: string,
  taskTitle: string,
  triggerContext: string,
  _eventId: string
): Promise<SendMessageResult> {
  const message = `🔔 *Proactive Reminder*

You have a pending task that might be relevant now:

📋 *Task:* ${taskTitle}

💡 *Triggered because:* You mentioned "${triggerContext}"

---
_Reply "done" to mark as complete, or "snooze" to remind later._`;

  return sendWhatsAppMessage(chatId, message);
}

/**
 * Sends a context clarification message
 */
export async function sendClarificationMessage(
  chatId: string,
  eventTitle: string,
  options: string[]
): Promise<SendMessageResult> {
  const optionsText = options.map((opt, i) => `${i + 1}️⃣ ${opt}`).join('\n');
  
  const message = `📍 *Quick question about:* "${eventTitle}"

Please clarify the type:

${optionsText}

_Reply with a number or describe in your words._`;

  return sendWhatsAppMessage(chatId, message);
}

/**
 * Sends a weekly digest message
 */
export async function sendWeeklyDigestMessage(
  chatId: string,
  tasks: Array<{ title: string; age: string }>
): Promise<SendMessageResult> {
  const taskList = tasks.map((t, i) => `${i + 1}. ${t.title} _(${t.age})_`).join('\n');
  
  const message = `📊 *Weekly Task Digest*

You have ${tasks.length} pending long-term task${tasks.length > 1 ? 's' : ''}:

${taskList}

---
_Reply with a task number to take action._`;

  return sendWhatsAppMessage(chatId, message);
}

/**
 * Formats chat ID to proper WhatsApp format
 */
function formatChatId(chatId: string): string {
  // If already in correct format, return as-is
  if (chatId.includes('@')) {
    return chatId.split('@')[0]; // Evolution API wants just the number
  }
  
  // Remove any non-numeric characters
  let cleaned = chatId.replace(/\D/g, '');
  
  // If starts with 0, assume Indian number and add 91
  if (cleaned.startsWith('0')) {
    cleaned = '91' + cleaned.slice(1);
  }
  
  // If doesn't have country code (less than 12 digits), assume Indian
  if (cleaned.length <= 10) {
    cleaned = '91' + cleaned;
  }
  
  return cleaned;
}

/**
 * Sends a reminder that an event is upcoming
 */
export async function sendUpcomingEventReminder(
  chatId: string,
  eventTitle: string,
  timeDescription: string,
  _eventId: string
): Promise<SendMessageResult> {
  const message = `⏰ *Upcoming Event Reminder*

📋 *Event:* ${eventTitle}
🕐 *When:* ${timeDescription}

---
_Reply "done" if already handled._`;

  return sendWhatsAppMessage(chatId, message);
}

export default {
  sendWhatsAppMessage,
  sendProactiveReminderMessage,
  sendClarificationMessage,
  sendWeeklyDigestMessage,
  sendUpcomingEventReminder,
};
