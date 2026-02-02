/**
 * Scheduler Service
 * 
 * Handles time-based reminder scheduling and triggering.
 * Persists reminders to database for crash recovery.
 */

import { v4 as uuidv4 } from 'uuid';
import { StoredEvent, ScheduledReminder } from '../types/index.js';
import { sendNotification } from '../notifications/index.js';
import { 
  storeReminder, 
  markReminderSent, 
  getPendingReminders as getPendingRemindersFromDB,
  deleteReminder,
  getEventById 
} from '../database/sqlite.js';
import logger from '../utils/logger.js';

// In-memory timer storage (for active timeouts)
// Database stores the reminder data, this just tracks active timers
const activeTimers: Map<string, NodeJS.Timeout> = new Map();

// Default reminder offset (15 minutes before event)
const DEFAULT_REMINDER_OFFSET_MS = 15 * 60 * 1000;

/**
 * Initialize the scheduler - loads pending reminders from database
 */
export async function initScheduler(): Promise<void> {
  logger.info('Initializing scheduler...');
  
  try {
    const pendingReminders = getPendingRemindersFromDB();
    logger.info(`Found ${pendingReminders.length} pending reminders in database`);
    
    for (const reminder of pendingReminders) {
      const event = getEventById(reminder.event_id);
      if (!event) {
        logger.warn('Event not found for reminder, deleting', { reminderId: reminder.id, eventId: reminder.event_id });
        deleteReminder(reminder.id);
        continue;
      }
      
      // Schedule the timer for this reminder
      scheduleTimerForReminder(reminder.id, reminder.event_id, reminder.trigger_time, event);
    }
    
    logger.info('Scheduler initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize scheduler', { error });
  }
}

/**
 * Schedules a reminder for an event
 */
export async function scheduleReminder(event: StoredEvent): Promise<ScheduledReminder | null> {
  if (!event.start_time) {
    logger.debug('No start time, skipping reminder', { eventId: event.id });
    return null;
  }

  const startTime = new Date(event.start_time);
  const reminderTime = new Date(startTime.getTime() - DEFAULT_REMINDER_OFFSET_MS);
  const now = new Date();

  // If reminder time is in the past, don't schedule
  if (reminderTime <= now) {
    logger.debug('Reminder time is in past, skipping', { eventId: event.id });
    return null;
  }

  // Cancel existing reminder for this event
  cancelReminder(event.id);

  const reminder: ScheduledReminder = {
    id: uuidv4(),
    event_id: event.id,
    user_id: 'default',  // Single-user mode
    trigger_time: reminderTime.toISOString(),
    sent: false,
    created_at: new Date().toISOString(),
  };

  // Store reminder in database
  try {
    storeReminder({
      id: reminder.id,
      event_id: reminder.event_id,
      trigger_time: reminder.trigger_time,
      sent: false,
    });
  } catch (error) {
    logger.error('Failed to store reminder in database', { error, reminderId: reminder.id });
    return null;
  }

  // Schedule the timer
  scheduleTimerForReminder(reminder.id, event.id, reminder.trigger_time, event);

  logger.info('Reminder scheduled', {
    eventId: event.id,
    reminderId: reminder.id,
    triggerTime: reminder.trigger_time,
  });

  return reminder;
}

/**
 * Internal helper to schedule a timer for a reminder
 */
function scheduleTimerForReminder(
  reminderId: string, 
  eventId: string, 
  triggerTime: string, 
  event: StoredEvent
): void {
  const now = new Date();
  const reminderDate = new Date(triggerTime);
  const delay = reminderDate.getTime() - now.getTime();

  if (delay <= 0) {
    logger.debug('Reminder trigger time is in the past, triggering immediately', { reminderId });
    // Trigger immediately
    triggerReminder(reminderId, event);
    return;
  }

  logger.debug('Setting timer for reminder', { 
    reminderId, 
    eventId, 
    delayMs: delay,
    delayMinutes: Math.round(delay / 60000),
  });

  // Clear existing timer for this event if any
  const existingTimer = activeTimers.get(eventId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new timer
  const timeout = setTimeout(async () => {
    await triggerReminder(reminderId, event);
  }, delay);

  activeTimers.set(eventId, timeout);
}

/**
 * Cancels a scheduled reminder
 */
export function cancelReminder(eventId: string): boolean {
  const timeout = activeTimers.get(eventId);
  if (timeout) {
    clearTimeout(timeout);
    activeTimers.delete(eventId);
    logger.debug('Reminder timer cancelled', { eventId });
    return true;
  }
  return false;
}

/**
 * Triggers a reminder notification
 */
async function triggerReminder(reminderId: string, event: StoredEvent): Promise<void> {
  logger.info('Triggering reminder', {
    reminderId,
    eventId: event.id,
    eventTitle: event.title,
  });

  try {
    await sendNotification({
      type: 'reminder',
      event_id: event.id,
      title: 'Upcoming Event',
      body: `Reminder: ${event.title || 'Event'} starts in 15 minutes`,
      data: {
        start_time: event.start_time,
        end_time: event.end_time,
        contact_name: event.contact_name,
        participants: event.participants,
      },
    });

    // Mark as sent in database
    markReminderSent(reminderId);

    logger.info('Reminder sent successfully', { reminderId, eventId: event.id });
  } catch (error) {
    logger.error('Failed to send reminder notification', { error, reminderId });
  } finally {
    // Cleanup timer reference
    activeTimers.delete(event.id);
  }
}

/**
 * Gets all pending reminders from database
 */
export function getPendingReminders(): ScheduledReminder[] {
  const dbReminders = getPendingRemindersFromDB();
  return dbReminders.map(r => ({
    id: r.id,
    event_id: r.event_id,
    user_id: 'default',
    trigger_time: r.trigger_time,
    sent: false,
    created_at: '', // Not stored in DB for this query
  }));
}

/**
 * Gets a specific reminder (checks if timer is active)
 */
export function getReminder(eventId: string): { active: boolean; reminderId?: string } {
  const hasActiveTimer = activeTimers.has(eventId);
  return { active: hasActiveTimer };
}

/**
 * Cleans up all scheduled reminders (for shutdown)
 */
export function cleanupReminders(): void {
  for (const [eventId, timeout] of activeTimers.entries()) {
    clearTimeout(timeout);
    logger.debug('Timer cancelled during cleanup', { eventId });
  }
  activeTimers.clear();
  logger.info('All reminder timers cleaned up');
}

/**
 * Get count of active timers (for monitoring)
 */
export function getActiveTimerCount(): number {
  return activeTimers.size;
}

export default { 
  initScheduler,
  scheduleReminder, 
  cancelReminder, 
  getPendingReminders, 
  getReminder, 
  cleanupReminders,
  getActiveTimerCount,
};
