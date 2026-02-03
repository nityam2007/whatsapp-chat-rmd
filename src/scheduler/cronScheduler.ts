/**
 * Cron Scheduler Service
 * 
 * Provides persistent, cron-based reminder checking as a backup to in-memory timers.
 * This ensures reminders are triggered even after server restarts.
 * 
 * Features:
 * - Polls database every minute for due reminders
 * - Sends weekly digest for long-term tasks (every Sunday at 9am)
 * - Handles proactive trigger scheduling
 * - Survives server restarts
 */

import { CronJob } from 'cron';
import { 
  getEventsForProactiveTrigger,
  getEventById,
  getPendingReminders as getPendingRemindersFromDB,
  markReminderSent,
} from '../database/sqlite.js';
import { sendNotification } from '../notifications/index.js';
import logger from '../utils/logger.js';

// Active cron jobs
let reminderCronJob: CronJob | null = null;
let weeklyDigestCronJob: CronJob | null = null;

/**
 * Initialize all cron jobs
 */
export function initCronScheduler(): void {
  logger.info('Initializing cron scheduler...');

  // Reminder check job - runs every minute
  reminderCronJob = new CronJob(
    '* * * * *', // Every minute
    async () => {
      await checkDueReminders();
    },
    null,
    false, // Don't start automatically
    'Asia/Kolkata' // Timezone
  );

  // Weekly digest job - runs every Sunday at 9am
  weeklyDigestCronJob = new CronJob(
    '0 9 * * 0', // At 09:00 on Sunday
    async () => {
      await sendWeeklyDigest();
    },
    null,
    false,
    'Asia/Kolkata'
  );

  // Start jobs
  reminderCronJob.start();
  weeklyDigestCronJob.start();

  logger.info('Cron scheduler initialized', {
    reminderCheck: 'every minute',
    weeklyDigest: 'Sundays at 9am IST',
  });
}

/**
 * Stop all cron jobs (for graceful shutdown)
 */
export function stopCronScheduler(): void {
  if (reminderCronJob) {
    reminderCronJob.stop();
    reminderCronJob = null;
  }
  if (weeklyDigestCronJob) {
    weeklyDigestCronJob.stop();
    weeklyDigestCronJob = null;
  }
  logger.info('Cron scheduler stopped');
}

/**
 * Check for due reminders and trigger them
 * This is a backup mechanism in case in-memory timers were lost
 */
async function checkDueReminders(): Promise<void> {
  try {
    const now = new Date();
    const pendingReminders = getPendingRemindersFromDB();

    for (const reminder of pendingReminders) {
      const triggerTime = new Date(reminder.trigger_time);
      
      // If trigger time is in the past (or within 1 minute), trigger immediately
      if (triggerTime <= now) {
        const event = getEventById(reminder.event_id);
        if (!event) {
          logger.warn('Event not found for due reminder', { 
            reminderId: reminder.id, 
            eventId: reminder.event_id 
          });
          continue;
        }

        logger.info('Cron triggering due reminder', {
          reminderId: reminder.id,
          eventId: event.id,
          eventTitle: event.title,
          scheduledTime: triggerTime.toISOString(),
        });

        try {
          // Send web push notification (WhatsApp is read-only)
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

          // Mark as sent
          markReminderSent(reminder.id);

          logger.info('Cron reminder sent successfully', { 
            reminderId: reminder.id, 
            eventId: event.id 
          });
        } catch (error) {
          logger.error('Failed to send cron reminder', { 
            error, 
            reminderId: reminder.id,
            eventId: event.id,
          });
        }
      }
    }
  } catch (error) {
    logger.error('Error in checkDueReminders cron job', { error });
  }
}

/**
 * Send weekly digest of pending tasks
 * Focuses on long-term tasks that might be forgotten
 */
async function sendWeeklyDigest(): Promise<void> {
  try {
    logger.info('Sending weekly digest...');

    // Get all pending events (tasks without specific times)
    const pendingEvents = getEventsForProactiveTrigger(50);

    if (pendingEvents.length === 0) {
      logger.info('No pending events for weekly digest');
      return;
    }

    // Group by age - older tasks are more likely forgotten
    const now = new Date();
    const oldTasks = pendingEvents.filter(e => {
      const created = new Date(e.created_at);
      const daysOld = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      return daysOld > 7; // Tasks older than a week
    });

    const recentTasks = pendingEvents.filter(e => {
      const created = new Date(e.created_at);
      const daysOld = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      return daysOld <= 7;
    });

    // Format for notification
    let digestMessage = `You have ${pendingEvents.length} pending tasks.\n\n`;

    if (oldTasks.length > 0) {
      digestMessage += `**Older tasks (over a week old):**\n`;
      for (const task of oldTasks.slice(0, 5)) {
        const daysOld = Math.floor(
          (now.getTime() - new Date(task.created_at).getTime()) / (1000 * 60 * 60 * 24)
        );
        digestMessage += `- ${task.title} (${daysOld} days old)\n`;
      }
      if (oldTasks.length > 5) {
        digestMessage += `... and ${oldTasks.length - 5} more\n`;
      }
      digestMessage += '\n';
    }

    if (recentTasks.length > 0) {
      digestMessage += `**Recent tasks:**\n`;
      for (const task of recentTasks.slice(0, 5)) {
        digestMessage += `- ${task.title}\n`;
      }
      if (recentTasks.length > 5) {
        digestMessage += `... and ${recentTasks.length - 5} more\n`;
      }
    }

    // Send web push notification (use 'system' type for digest)
    await sendNotification({
      type: 'system',
      event_id: 'weekly-digest',
      title: 'Weekly Task Digest',
      body: digestMessage,
      data: {
        totalTasks: pendingEvents.length,
        oldTasks: oldTasks.length,
        recentTasks: recentTasks.length,
      },
    });

    logger.info('Weekly digest sent', {
      totalTasks: pendingEvents.length,
      oldTasks: oldTasks.length,
      recentTasks: recentTasks.length,
    });
  } catch (error) {
    logger.error('Error sending weekly digest', { error });
  }
}

/**
 * Manually trigger a reminder check (for testing)
 */
export async function triggerReminderCheck(): Promise<void> {
  await checkDueReminders();
}

/**
 * Manually trigger weekly digest (for testing)
 */
export async function triggerWeeklyDigest(): Promise<void> {
  await sendWeeklyDigest();
}

/**
 * Get cron scheduler status
 */
export function getCronStatus(): { reminderJob: boolean; digestJob: boolean } {
  return {
    reminderJob: reminderCronJob !== null,
    digestJob: weeklyDigestCronJob !== null,
  };
}

export default {
  initCronScheduler,
  stopCronScheduler,
  triggerReminderCheck,
  triggerWeeklyDigest,
  getCronStatus,
};
