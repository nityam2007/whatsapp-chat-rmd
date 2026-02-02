/**
 * Notification Service
 * 
 * Handles Web Push notifications to users.
 * Manages push subscriptions and sends notifications.
 */

import webPush from 'web-push';
import { Redis } from 'ioredis';
import { NotificationPayload, PushSubscriptionData } from '../shared/types.js';
import { generateId, now } from '../shared/utils.js';
import logger from '../utils/logger.js';
import { config } from '../config/index.js';

interface NotificationLog {
  id: string;
  userId: string;
  payload: NotificationPayload;
  status: 'sent' | 'failed' | 'pending';
  error?: string;
  sentAt: string;
}

export class NotificationService {
  private redis: Redis;
  private subscriptions: Map<string, PushSubscriptionData[]> = new Map();
  private notificationHistory: NotificationLog[] = [];

  constructor() {
    this.redis = new Redis(config.redisUrl);
    this.setupWebPush();
    this.loadSubscriptions();
  }

  private setupWebPush(): void {
    if (config.vapidPublicKey && config.vapidPrivateKey) {
      webPush.setVapidDetails(
        config.vapidEmail,
        config.vapidPublicKey,
        config.vapidPrivateKey
      );
      logger.info('Web Push configured');
    } else {
      logger.warn('VAPID keys not configured - Web Push disabled');
    }
  }

  private async loadSubscriptions(): Promise<void> {
    try {
      const keys = await this.redis.keys('push:subscription:*');
      for (const key of keys) {
        const userId = key.replace('push:subscription:', '');
        const subs = await this.redis.lrange(key, 0, -1);
        this.subscriptions.set(
          userId,
          subs.map(s => JSON.parse(s) as PushSubscriptionData)
        );
      }
      logger.info('Loaded push subscriptions', { count: this.subscriptions.size });
    } catch (error) {
      logger.error('Failed to load subscriptions', { error });
    }
  }

  /**
   * Registers a push subscription for a user
   */
  async registerSubscription(userId: string, subscription: PushSubscriptionData): Promise<void> {
    logger.info('Registering push subscription', { userId, endpoint: subscription.endpoint.slice(0, 50) });

    // Get existing subscriptions
    const existing = this.subscriptions.get(userId) || [];
    
    // Check if already registered
    const exists = existing.some(s => s.endpoint === subscription.endpoint);
    if (exists) {
      logger.debug('Subscription already registered', { userId });
      return;
    }

    // Add new subscription
    existing.push(subscription);
    this.subscriptions.set(userId, existing);

    // Store in Redis
    await this.redis.rpush(
      `push:subscription:${userId}`,
      JSON.stringify(subscription)
    );

    logger.info('Push subscription registered', { userId });
  }

  /**
   * Removes a push subscription
   */
  async removeSubscription(userId: string, endpoint: string): Promise<void> {
    const existing = this.subscriptions.get(userId) || [];
    const filtered = existing.filter(s => s.endpoint !== endpoint);
    
    this.subscriptions.set(userId, filtered);
    
    // Update Redis
    await this.redis.del(`push:subscription:${userId}`);
    for (const sub of filtered) {
      await this.redis.rpush(
        `push:subscription:${userId}`,
        JSON.stringify(sub)
      );
    }
  }

  /**
   * Sends a notification to a specific user
   */
  async sendToUser(userId: string, notification: NotificationPayload): Promise<boolean> {
    const subscriptions = this.subscriptions.get(userId) || [];
    
    if (subscriptions.length === 0) {
      logger.debug('No subscriptions for user', { userId });
      return false;
    }

    const log: NotificationLog = {
      id: generateId('notif'),
      userId,
      payload: notification,
      status: 'pending',
      sentAt: now(),
    };

    let anySuccess = false;

    for (const subscription of subscriptions) {
      try {
        await this.sendPushNotification(subscription, notification);
        anySuccess = true;
      } catch (error) {
        logger.error('Failed to send push notification', { 
          error, 
          userId, 
          endpoint: subscription.endpoint.slice(0, 50) 
        });

        // Remove invalid subscription
        if (this.isSubscriptionExpired(error as Error)) {
          await this.removeSubscription(userId, subscription.endpoint);
        }
      }
    }

    log.status = anySuccess ? 'sent' : 'failed';
    if (!anySuccess) {
      log.error = 'All subscriptions failed';
    }

    this.notificationHistory.push(log);
    
    // Keep only last 1000 notifications in memory
    if (this.notificationHistory.length > 1000) {
      this.notificationHistory = this.notificationHistory.slice(-1000);
    }

    return anySuccess;
  }

  /**
   * Sends a push notification
   */
  private async sendPushNotification(
    subscription: PushSubscriptionData,
    notification: NotificationPayload
  ): Promise<void> {
    const pushPayload = {
      title: notification.title,
      body: notification.body,
      icon: notification.icon || '/icon-192.png',
      badge: notification.badge || '/badge-72.png',
      data: {
        ...notification.data,
        type: notification.type,
        event_id: notification.event_id,
        timestamp: now(),
      },
      actions: notification.actions || [],
    };

    await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      JSON.stringify(pushPayload),
      {
        TTL: 60 * 60, // 1 hour
        urgency: 'high',
      }
    );

    logger.debug('Push notification sent', { 
      endpoint: subscription.endpoint.slice(0, 50),
      title: notification.title,
    });
  }

  /**
   * Checks if error indicates expired subscription
   */
  private isSubscriptionExpired(error: Error): boolean {
    const message = error.message || '';
    return (
      message.includes('expired') ||
      message.includes('unsubscribed') ||
      message.includes('410') ||
      message.includes('404')
    );
  }

  /**
   * Broadcasts notification to all users
   */
  async broadcast(notification: NotificationPayload): Promise<number> {
    let sentCount = 0;

    for (const userId of this.subscriptions.keys()) {
      const success = await this.sendToUser(userId, notification);
      if (success) sentCount++;
    }

    logger.info('Broadcast notification sent', { sentCount, totalUsers: this.subscriptions.size });
    return sentCount;
  }

  /**
   * Gets notification history for a user
   */
  getHistory(userId?: string, limit: number = 50): NotificationLog[] {
    let history = this.notificationHistory;
    
    if (userId) {
      history = history.filter(n => n.userId === userId);
    }
    
    return history.slice(-limit).reverse();
  }

  /**
   * Gets subscription count
   */
  getSubscriptionCount(): number {
    let total = 0;
    for (const subs of this.subscriptions.values()) {
      total += subs.length;
    }
    return total;
  }

  /**
   * Gets user subscription status
   */
  hasSubscription(userId: string): boolean {
    const subs = this.subscriptions.get(userId);
    return subs !== undefined && subs.length > 0;
  }
}

export default NotificationService;
