/**
 * Notification Service
 * 
 * Handles sending notifications via Web Push or other channels.
 * Stores subscriptions in the database for persistence.
 */

import { NotificationPayload, PushSubscriptionData } from '../types/index.js';
import { config } from '../config/index.js';
import { 
  storePushSubscription, 
  getPushSubscriptions, 
  getAllPushSubscriptions,
  deletePushSubscription,
  updatePushSubscriptionLastUsed,
} from '../database/sqlite.js';
import logger from '../utils/logger.js';

// Notification queue for development/testing
const notificationHistory: NotificationPayload[] = [];

// Max history size to prevent memory issues
const MAX_HISTORY_SIZE = 100;

/**
 * Sends a notification to all subscribers
 */
export async function sendNotification(payload: NotificationPayload): Promise<boolean> {
  logger.info('Sending notification', {
    type: payload.type,
    eventId: payload.event_id,
    title: payload.title,
  });

  // Store in history
  notificationHistory.push({
    ...payload,
    data: {
      ...payload.data,
      timestamp: new Date().toISOString(),
    },
  });

  // Trim history if too large
  if (notificationHistory.length > MAX_HISTORY_SIZE) {
    notificationHistory.splice(0, notificationHistory.length - MAX_HISTORY_SIZE);
  }

  // If Web Push is configured, send via Web Push
  if (config.vapidPublicKey && config.vapidPrivateKey) {
    return sendWebPushToAll(payload);
  }

  // Otherwise, just log (development mode)
  logger.info('Notification (dev mode)', {
    type: payload.type,
    title: payload.title,
    body: payload.body,
  });

  return true;
}

/**
 * Sends notification via Web Push to all subscribers
 */
async function sendWebPushToAll(payload: NotificationPayload): Promise<boolean> {
  try {
    // Dynamic import to avoid issues if web-push isn't fully configured
    const webPush = await import('web-push');
    
    webPush.setVapidDetails(
      config.vapidEmail,
      config.vapidPublicKey,
      config.vapidPrivateKey
    );

    // Get all subscriptions from database
    const subscriptions = getAllPushSubscriptions();
    
    if (subscriptions.length === 0) {
      logger.debug('No push subscriptions registered');
      return true;
    }

    logger.info('Sending push to subscribers', { count: subscriptions.length });

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        };

        try {
          await webPush.sendNotification(
            pushSubscription,
            JSON.stringify({
              title: payload.title,
              body: payload.body,
              type: payload.type,
              event_id: payload.event_id,
              data: payload.data,
            })
          );
          
          // Update last used timestamp
          updatePushSubscriptionLastUsed(sub.endpoint);
          
          return { success: true, endpoint: sub.endpoint };
        } catch (error) {
          // If subscription is expired/invalid, delete it
          if (error instanceof Error && 'statusCode' in error) {
            const statusCode = (error as { statusCode: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
              logger.info('Removing expired subscription', { endpoint: sub.endpoint.slice(0, 50) });
              deletePushSubscription(sub.endpoint);
            }
          }
          throw error;
        }
      })
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    logger.info('Push notifications sent', { successful, failed });
    
    return successful > 0;
  } catch (error) {
    logger.error('Web Push failed', { error });
    return false;
  }
}

/**
 * Sends notification to a specific user
 */
export async function sendNotificationToUser(
  userId: string,
  payload: NotificationPayload
): Promise<boolean> {
  if (!config.vapidPublicKey || !config.vapidPrivateKey) {
    logger.debug('Web Push not configured, logging notification');
    return true;
  }

  try {
    const webPush = await import('web-push');
    
    webPush.setVapidDetails(
      config.vapidEmail,
      config.vapidPublicKey,
      config.vapidPrivateKey
    );

    const subscriptions = getPushSubscriptions(userId);
    
    if (subscriptions.length === 0) {
      logger.debug('No subscriptions for user', { userId });
      return false;
    }

    for (const sub of subscriptions) {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            type: payload.type,
            event_id: payload.event_id,
            data: payload.data,
          })
        );
        
        updatePushSubscriptionLastUsed(sub.endpoint);
      } catch (error) {
        if (error instanceof Error && 'statusCode' in error) {
          const statusCode = (error as { statusCode: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            deletePushSubscription(sub.endpoint);
          }
        }
        logger.error('Failed to send push', { error, endpoint: sub.endpoint.slice(0, 50) });
      }
    }

    return true;
  } catch (error) {
    logger.error('Web Push to user failed', { error, userId });
    return false;
  }
}

/**
 * Gets notification history (for development/debugging)
 */
export function getNotificationHistory(): NotificationPayload[] {
  return [...notificationHistory];
}

/**
 * Clears notification history
 */
export function clearNotificationHistory(): void {
  notificationHistory.length = 0;
}

/**
 * Registers a Web Push subscription
 * Stores in database for persistence across restarts
 */
export async function registerSubscription(
  subscription: PushSubscriptionData,
  userId?: string
): Promise<boolean> {
  try {
    logger.info('Registering push subscription', {
      endpoint: subscription.endpoint?.slice(0, 50) + '...',
      userId: userId || 'default',
    });
    
    if (!subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      logger.error('Invalid subscription data', { subscription });
      return false;
    }

    storePushSubscription({
      user_id: userId,
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    });
    
    return true;
  } catch (error) {
    logger.error('Failed to register subscription', { error });
    return false;
  }
}

/**
 * Unregisters a Web Push subscription
 */
export async function unregisterSubscription(endpoint: string): Promise<boolean> {
  try {
    return deletePushSubscription(endpoint);
  } catch (error) {
    logger.error('Failed to unregister subscription', { error });
    return false;
  }
}

/**
 * Gets count of registered subscriptions
 */
export function getSubscriptionCount(): number {
  return getAllPushSubscriptions().length;
}

export default { 
  sendNotification,
  sendNotificationToUser,
  getNotificationHistory, 
  clearNotificationHistory,
  registerSubscription,
  unregisterSubscription,
  getSubscriptionCount,
};
