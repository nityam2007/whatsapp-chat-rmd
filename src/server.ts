/**
 * Express Server Setup
 * 
 * Main API server with endpoints for:
 * - Events management (CRUD, accept/decline)
 * - Messages viewing
 * - Dashboard stats
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { webhookRouter } from './webhook/evolution.js';
import { config } from './config/index.js';
import { 
  getISTTimestamp,
  getMessages,
  getMessagesWithPipelineData,
  getEvents,
  getEventById,
  updateEventStatus,
  deleteEvent,
  getUpcomingEvents,
  getEventStats,
  getMessageStats,
  getPipelineLogs,
  getEventsByContext,
  getHotEvents,
  getExtensionStats,
  ExtensionContextQuery,
} from './database/sqlite.js';
import logger from './utils/logger.js';
import { metrics } from './utils/metrics.js';
import { 
  registerSubscription, 
  unregisterSubscription, 
  sendNotification,
  getSubscriptionCount,
} from './notifications/index.js';

// Notification history storage (in-memory for now)
let notificationHistory: Array<{ id: string; message: string; timestamp: string }> = [];

export function getNotificationHistory() {
  return notificationHistory;
}

export function addNotification(notification: { id: string; message: string; timestamp: string }) {
  notificationHistory.push(notification);
  // Keep only last 100 notifications
  if (notificationHistory.length > 100) {
    notificationHistory = notificationHistory.slice(-100);
  }
}

// Simple rate limiting
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 100; // requests per window
const RATE_WINDOW = 60 * 1000; // 1 minute

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  const record = rateLimitMap.get(ip);
  
  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    next();
    return;
  }
  
  if (record.count >= RATE_LIMIT) {
    res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((record.resetTime - now) / 1000) });
    return;
  }
  
  record.count++;
  next();
}

// Simple API key auth (optional)
function apiAuth(req: Request, res: Response, next: NextFunction): void {
  const apiSecret = process.env.API_SECRET;
  
  // If no secret configured, allow all requests
  if (!apiSecret) {
    next();
    return;
  }
  
  const authHeader = req.headers.authorization;
  const providedKey = authHeader?.replace('Bearer ', '');
  
  if (providedKey === apiSecret) {
    next();
    return;
  }
  
  // Allow requests from localhost without auth
  const ip = req.ip || req.socket.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
    next();
    return;
  }
  
  res.status(401).json({ error: 'Unauthorized' });
}

export function createServer(): Express {
  const app = express();

  // Middleware
  app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(rateLimit);

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.debug('Request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration,
      });
    });
    
    next();
  });

  // =============================================
  // Public Endpoints
  // =============================================

  // Health check
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Argus',
      version: '0.9.0',
      status: 'running',
      timezone: config.timezone,
      timestamp: getISTTimestamp(),
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: getISTTimestamp() });
  });

  // =============================================
  // Webhook routes
  // =============================================
  app.use('/webhook', webhookRouter);

  // =============================================
  // Dashboard Stats
  // =============================================
  app.get('/api/dashboard/stats', apiAuth, (_req: Request, res: Response) => {
    try {
      const eventStats = getEventStats();
      const messageStats = getMessageStats();
      const upcomingEvents = getUpcomingEvents(5);
      
      res.json({
        events: eventStats,
        messages: messageStats,
        upcoming: upcomingEvents,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get dashboard stats', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Events API
  // =============================================
  
  // List events
  app.get('/api/events', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const status = req.query.status as string;
      const contactName = req.query.contact as string;
      const search = req.query.search as string;
      
      const result = getEvents({ limit, offset, status, contactName, search });
      
      res.json({
        events: result.events,
        total: result.total,
        limit,
        offset,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to list events', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get upcoming events (MUST be before /api/events/:id to avoid route conflict)
  app.get('/api/events/upcoming', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const events = getUpcomingEvents(limit);
      
      res.json({
        events,
        count: events.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get upcoming events', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get single event
  app.get('/api/events/:id', apiAuth, (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const event = getEventById(id);
      
      if (!event) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }
      
      res.json({ event, timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to get event', { error, id: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Accept event
  app.post('/api/events/:id/accept', apiAuth, (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const event = updateEventStatus(id, 'active');
      
      if (!event) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }
      
      logger.info('Event accepted', { id });
      res.json({ event, message: 'Event accepted', timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to accept event', { error, id: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Decline event
  app.post('/api/events/:id/decline', apiAuth, (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const event = updateEventStatus(id, 'declined');
      
      if (!event) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }
      
      logger.info('Event declined', { id });
      res.json({ event, message: 'Event declined', timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to decline event', { error, id: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Snooze event
  app.post('/api/events/:id/snooze', apiAuth, (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const event = updateEventStatus(id, 'snoozed');
      
      if (!event) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }
      
      logger.info('Event snoozed', { id });
      res.json({ event, message: 'Event snoozed', timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to snooze event', { error, id: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Complete event
  app.post('/api/events/:id/complete', apiAuth, (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const event = updateEventStatus(id, 'completed');
      
      if (!event) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }
      
      logger.info('Event completed', { id });
      res.json({ event, message: 'Event completed', timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to complete event', { error, id: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete event
  app.delete('/api/events/:id', apiAuth, (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const deleted = deleteEvent(id);
      
      if (!deleted) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }
      
      logger.info('Event deleted', { id });
      res.json({ message: 'Event deleted', timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to delete event', { error, id: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Messages API
  // =============================================
  
  // List messages
  app.get('/api/messages', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const chatId = req.query.chat as string;
      const search = req.query.search as string;
      
      const result = getMessages({ limit, offset, chatId, search });
      
      res.json({
        messages: result.messages,
        total: result.total,
        limit,
        offset,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to list messages', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });


  // =============================================
  // Notifications API
  // =============================================
  
  app.get('/api/notifications', apiAuth, (_req: Request, res: Response) => {
    res.json({ notifications: getNotificationHistory() });
  });

  // Get VAPID public key for push subscription
  app.get('/api/push/vapid-key', (_req: Request, res: Response) => {
    res.json({ 
      publicKey: config.vapidPublicKey || '',
      configured: !!(config.vapidPublicKey && config.vapidPrivateKey),
    });
  });

  // Register push subscription
  app.post('/api/push/subscribe', async (req: Request, res: Response) => {
    try {
      const subscription = req.body;
      
      if (!subscription || !subscription.endpoint || !subscription.keys) {
        res.status(400).json({ error: 'Invalid subscription data' });
        return;
      }

      const success = await registerSubscription({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
      });

      if (success) {
        logger.info('Push subscription registered', { 
          endpoint: subscription.endpoint.slice(0, 50) + '...',
        });
        res.json({ 
          success: true, 
          message: 'Subscribed successfully',
          count: getSubscriptionCount(),
        });
      } else {
        res.status(500).json({ error: 'Failed to register subscription' });
      }
    } catch (error) {
      logger.error('Push subscription failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Unregister push subscription
  app.post('/api/push/unsubscribe', async (req: Request, res: Response) => {
    try {
      const { endpoint } = req.body;
      
      if (!endpoint) {
        res.status(400).json({ error: 'Endpoint required' });
        return;
      }

      const success = await unregisterSubscription(endpoint);
      
      logger.info('Push subscription removed', { 
        endpoint: endpoint.slice(0, 50) + '...',
        success,
      });
      
      res.json({ success: true, message: 'Unsubscribed' });
    } catch (error) {
      logger.error('Push unsubscription failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send test push notification
  app.post('/api/push/test', async (req: Request, res: Response) => {
    try {
      const { title, body } = req.body;
      
      const success = await sendNotification({
        type: 'system',
        title: title || 'Test Notification',
        body: body || 'This is a test push notification from Argus',
        icon: '/icon-192.svg',
        data: { test: true },
      });

      res.json({ 
        success, 
        message: success ? 'Test notification sent' : 'No subscriptions found',
        subscriptionCount: getSubscriptionCount(),
      });
    } catch (error) {
      logger.error('Test notification failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get push subscription status
  app.get('/api/push/status', (_req: Request, res: Response) => {
    res.json({
      configured: !!(config.vapidPublicKey && config.vapidPrivateKey),
      subscriptionCount: getSubscriptionCount(),
    });
  });

  // =============================================
  // Chrome Extension API
  // =============================================

  // Submit browser context and get matching events
  app.post('/api/extension/context', async (req: Request, res: Response) => {
    try {
      const { url, pageTitle, keywords, location, activity } = req.body as ExtensionContextQuery;
      
      if (!url && !keywords && !location && !activity) {
        res.status(400).json({ error: 'At least one context parameter required' });
        return;
      }
      
      logger.info('Extension context received', { url, pageTitle, keywords, location, activity });
      
      const matches = getEventsByContext({ url, pageTitle, keywords, location, activity });
      
      res.json({
        success: true,
        matches: matches.map(m => ({
          event: {
            id: m.event.id,
            title: m.event.title,
            status: m.event.status,
            location: m.event.location,
            context_tags: m.event.context_tags,
            contact_name: m.event.contact_name,
            start_time_ist: m.event.start_time_ist,
            created_at: m.event.created_at,
          },
          matchType: m.matchType,
          matchedValue: m.matchedValue,
          confidence: m.confidence,
        })),
        count: matches.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Extension context query failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get events by location (quick endpoint for location-based triggers)
  app.get('/api/extension/by-location', (req: Request, res: Response) => {
    try {
      const location = req.query.location as string;
      
      if (!location) {
        res.status(400).json({ error: 'Location parameter required' });
        return;
      }
      
      const matches = getEventsByContext({ location });
      
      res.json({
        success: true,
        events: matches.map(m => m.event),
        count: matches.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Extension location query failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get all hot events (for extension cache sync)
  app.get('/api/extension/hot-events', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 200;
      const events = getHotEvents(limit);
      
      res.json({
        success: true,
        events: events.map(e => ({
          id: e.id,
          title: e.title,
          status: e.status,
          location: e.location,
          context_tags: e.context_tags,
          trigger_keywords: e.trigger_keywords,
          contact_name: e.contact_name,
          created_at: e.created_at,
        })),
        count: events.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Extension hot events query failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Extension heartbeat/status
  app.get('/api/extension/status', (_req: Request, res: Response) => {
    try {
      const stats = getExtensionStats();
      
      res.json({
        success: true,
        status: 'connected',
        stats,
        serverVersion: '0.9.0',
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Extension status failed', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Pipeline Logs API
  // =============================================
  
  // List available pipeline log files
  app.get('/api/logs', apiAuth, (_req: Request, res: Response) => {
    try {
      const logsDir = path.join(process.cwd(), 'logs', 'pipeline');
      
      if (!fs.existsSync(logsDir)) {
        res.json({ logs: [] });
        return;
      }
      
      const files = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.log'))
        .map(f => {
          const stats = fs.statSync(path.join(logsDir, f));
          return {
            name: f.replace('.log', ''),
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        });
      
      res.json({ logs: files, timestamp: getISTTimestamp() });
    } catch (error) {
      logger.error('Failed to list logs', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List all log files (both pipeline and root) - MUST be before /api/logs/:step
  app.get('/api/logs/all', apiAuth, (_req: Request, res: Response) => {
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      const pipelineDir = path.join(logsDir, 'pipeline');
      const dataLogsDir = path.join(process.cwd(), 'data', 'logs');
      
      const result: { name: string; path: string; size: number; modified: string }[] = [];
      
      // Root log files
      if (fs.existsSync(logsDir)) {
        const rootFiles = fs.readdirSync(logsDir)
          .filter(f => f.endsWith('.log'))
          .map(f => {
            const stats = fs.statSync(path.join(logsDir, f));
            return {
              name: f,
              path: `logs/${f}`,
              size: stats.size,
              modified: stats.mtime.toISOString(),
            };
          });
        result.push(...rootFiles);
      }
      
      // Pipeline log files
      if (fs.existsSync(pipelineDir)) {
        const pipelineFiles = fs.readdirSync(pipelineDir)
          .filter(f => f.endsWith('.log'))
          .map(f => {
            const stats = fs.statSync(path.join(pipelineDir, f));
            return {
              name: `pipeline/${f}`,
              path: `logs/pipeline/${f}`,
              size: stats.size,
              modified: stats.mtime.toISOString(),
            };
          });
        result.push(...pipelineFiles);
      }
      
      // Data logs
      if (fs.existsSync(dataLogsDir)) {
        const dataFiles = fs.readdirSync(dataLogsDir)
          .filter(f => f.endsWith('.log'))
          .map(f => {
            const stats = fs.statSync(path.join(dataLogsDir, f));
            return {
              name: `data/${f}`,
              path: `data/logs/${f}`,
              size: stats.size,
              modified: stats.mtime.toISOString(),
            };
          });
        result.push(...dataFiles);
      }
      
      res.json({ 
        logs: result,
        count: result.length,
        timestamp: getISTTimestamp() 
      });
    } catch (error) {
      logger.error('Failed to list all logs', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Read any log file (not just pipeline) - MUST be before /api/logs/:step
  app.get('/api/logs/file/:filename', apiAuth, (req: Request, res: Response) => {
    try {
      const filename = req.params.filename as string;
      const lines = parseInt(req.query.lines as string) || 100;
      
      // Security: only allow specific log files
      const allowedFiles = [
        'rmd.log', 'error.log', 'exceptions.log', 'rejections.log',
        'evolution.log', 'webapp.log'
      ];
      
      if (!allowedFiles.includes(filename)) {
        res.status(400).json({ error: 'Invalid log file', allowedFiles });
        return;
      }
      
      const logPath = path.join(process.cwd(), 'logs', filename);
      
      if (!fs.existsSync(logPath)) {
        res.json({ filename, entries: [], message: 'Log file not found or empty' });
        return;
      }
      
      const content = fs.readFileSync(logPath, 'utf-8');
      const allLines = content.split('\n').filter(Boolean);
      const entries = allLines.slice(-lines); // Get last N lines
      
      res.json({
        filename,
        entries,
        totalLines: allLines.length,
        count: entries.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to read log file', { error, filename: req.params.filename });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get specific pipeline step log - MUST be after /api/logs/all and /api/logs/file/:filename
  app.get('/api/logs/:step', apiAuth, (req: Request, res: Response) => {
    try {
      const step = req.params.step as string;
      const lines = parseInt(req.query.lines as string) || 100;
      
      const validSteps = [
        '00-errors',
        '01-webhook', 
        '02-heuristic', 
        '03-classification',
        '04-context',
        '05-extraction',
        '06-events',
        '07-summary'
      ];
      
      if (!validSteps.includes(step)) {
        res.status(400).json({ error: 'Invalid log step', validSteps });
        return;
      }
      
      const logPath = path.join(process.cwd(), 'logs', 'pipeline', `${step}.log`);
      
      if (!fs.existsSync(logPath)) {
        res.json({ logs: [], message: 'No logs yet' });
        return;
      }
      
      const content = fs.readFileSync(logPath, 'utf-8');
      const entries = content.split('\n---\n').filter(Boolean).slice(0, lines);
      
      res.json({
        step,
        entries,
        count: entries.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to read logs', { error, step: req.params.step });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Pipeline Data API (Database-backed logs)
  // =============================================
  
  // Get pipeline logs for a specific message
  app.get('/api/pipeline/:messageId', apiAuth, (req: Request, res: Response) => {
    try {
      const messageId = req.params.messageId as string;
      const logs = getPipelineLogs(messageId);
      
      res.json({
        messageId,
        logs,
        count: logs.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get pipeline logs', { error, messageId: req.params.messageId });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Archive API
  // =============================================
  
  // Trigger manual archive
  app.post('/api/archive', apiAuth, (_req: Request, res: Response) => {
    try {
      logger.info('Manual archive triggered');
      const result = archiveOldData();
      
      res.json({
        message: 'Archive completed',
        ...result,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Archive failed', { error });
      res.status(500).json({ error: 'Archive failed' });
    }
  });

  // Get archive metadata
  app.get('/api/archive', apiAuth, (_req: Request, res: Response) => {
    try {
      const archives = getArchiveMetadata();
      
      res.json({
        archives,
        count: archives.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get archive metadata', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Pipeline Metrics API
  // =============================================
  
  // Get full metrics
  app.get('/api/metrics', apiAuth, (_req: Request, res: Response) => {
    try {
      const pipelineMetrics = metrics.getMetrics();
      res.json({
        metrics: pipelineMetrics,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get metrics', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get metrics summary (human-readable)
  app.get('/api/metrics/summary', apiAuth, (_req: Request, res: Response) => {
    try {
      const summary = metrics.getSummary();
      res.json({
        summary,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get metrics summary', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Reset metrics (useful for testing, protected endpoint)
  app.post('/api/metrics/reset', apiAuth, (_req: Request, res: Response) => {
    try {
      metrics.reset();
      logger.info('Metrics reset via API');
      res.json({
        message: 'Metrics reset successfully',
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to reset metrics', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Data Collection Stats API
  // =============================================
  
  app.get('/api/data/stats', apiAuth, (_req: Request, res: Response) => {
    try {
      const eventStats = getEventStats();
      const messageStats = getMessageStats();
      const archives = getArchiveMetadata();
      
      // Calculate additional stats
      const totalArchived = archives.reduce((sum, a) => sum + a.messages_count + a.events_count, 0);
      
      res.json({
        messages: {
          ...messageStats,
          heuristicPassRate: messageStats.total > 0 
            ? Math.round((messageStats.processed / messageStats.total) * 100) 
            : 0,
        },
        events: eventStats,
        archives: {
          count: archives.length,
          totalArchived,
        },
        dataCollection: {
          hotDataPeriod: '3 months',
          archiveFormat: 'yyyy/mm/dd/archive',
          pipelineStagesTracked: [
            'received', 'heuristic', 'classification', 'context', 
            'compression', 'extraction', 'routing', 'error'
          ],
        },
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get data stats', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // COMPREHENSIVE DATA API (for dashboard)
  // =============================================

  // Get database statistics
  app.get('/api/db/stats', apiAuth, (_req: Request, res: Response) => {
    try {
      const stats = getDatabaseStats();
      res.json({
        ...stats,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get database stats', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get LLM calls with pagination

  // Get reminders with pagination
  app.get('/api/reminders', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const sent = req.query.sent === 'true' ? true : req.query.sent === 'false' ? false : undefined;
      
      const result = getReminders({ limit, offset, sent });
      
      res.json({
        reminders: result.reminders,
        total: result.total,
        limit,
        offset,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get reminders', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get all pipeline logs with pagination
  app.get('/api/pipeline-logs', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const stage = req.query.stage as string;
      const status = req.query.status as string;
      
      const result = getAllPipelineLogs({ limit, offset, stage, status });
      
      res.json({
        logs: result.logs,
        total: result.total,
        limit,
        offset,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get pipeline logs', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get messages with full pipeline data
  app.get('/api/messages/detailed', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const chatId = req.query.chat as string;
      const search = req.query.search as string;
      const heuristicPassed = req.query.heuristicPassed === 'true' ? true : 
                              req.query.heuristicPassed === 'false' ? false : undefined;
      const result = getMessagesWithPipelineData({ 
        limit, offset, chatId, search, heuristicPassed 
      });
      
      res.json({
        messages: result.messages,
        total: result.total,
        limit,
        offset,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get detailed messages', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // DATA CLEANUP API
  // =============================================

  // Clean up test/fake data
  app.post('/api/cleanup/test-data', apiAuth, (_req: Request, res: Response) => {
    try {
      const result = cleanupTestData();
      res.json({
        success: true,
        message: 'Test data cleanup completed',
        ...result,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to cleanup test data', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delete a specific contact and all related data
  app.delete('/api/contacts/:id', apiAuth, (req: Request, res: Response) => {
    try {
      const contactId = req.params.id as string;
      
      if (!contactId) {
        res.status(400).json({ error: 'Contact ID is required' });
        return;
      }
      
      const result = deleteContactAndData(contactId);
      res.json({
        success: true,
        message: `Contact ${contactId} and related data deleted`,
        ...result,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to delete contact', { error, contactId: req.params.id });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Error Handling
  // =============================================

  // Error handler
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Unhandled error', { error: err.message, stack: err.stack });
    
    // Handle JSON parsing errors
    if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON' });
      return;
    }
    
    // Handle other known error types
    if (err.status && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: err.message || 'Bad request' });
      return;
    }
    
    res.status(500).json({ error: 'Internal server error' });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

export function startServer(): void {
  const app = createServer();
  
  app.listen(config.port, () => {
    logger.info(`Server started on port ${config.port}`, {
      environment: config.nodeEnv,
      port: config.port,
    });
    
    console.log(`
+=====================================================================+
|                         Argus v1.0.0                                |
|              (Proactive Chrome Extension + AI Pipeline)             |
+=====================================================================+
|  Server: http://localhost:${String(config.port).padEnd(5)}                                  |
|  Environment: ${config.nodeEnv.padEnd(52)}|
|  Timezone: ${config.timezone.padEnd(55)}|
+---------------------------------------------------------------------+
|  API Endpoints:                                                     |
|    GET  /                         - Health check                    |
|    POST /webhook/evolution        - WhatsApp webhook                |
|    POST /webhook/test             - Test message                    |
|                                                                     |
|    GET  /api/dashboard/stats      - Dashboard statistics            |
|    GET  /api/data/stats           - Data collection stats           |
|    GET  /api/metrics              - Pipeline metrics (full)         |
|    GET  /api/metrics/summary      - Pipeline metrics (summary)      |
|                                                                     |
|    GET  /api/events               - List events                     |
|    GET  /api/events/:id           - Get event                       |
|    POST /api/events/:id/accept    - Accept event                    |
|    POST /api/events/:id/decline   - Decline event                   |
|    POST /api/events/:id/snooze    - Snooze event                    |
|    POST /api/events/:id/complete  - Complete event                  |
|    DEL  /api/events/:id           - Delete event                    |
|                                                                     |
|    GET  /api/messages             - List messages                   |
|    GET  /api/contacts             - List contacts                   |
|    GET  /api/logs                 - List pipeline logs              |
|    GET  /api/logs/:step           - Get specific log                |
|    GET  /api/pipeline/:messageId  - Get pipeline data for message   |
|                                                                     |
|    GET  /api/archive              - List archives                   |
|    POST /api/archive              - Trigger manual archive          |
|                                                                     |
|  Chrome Extension API (NEW):                                        |
|    POST /api/extension/context    - Submit browser context          |
|    GET  /api/extension/by-location- Query by location               |
|    GET  /api/extension/hot-events - Get 3-month hot events          |
|    GET  /api/extension/status     - Extension connection status     |
|                                                                     |
+=====================================================================+
    `);
  });
}

export default { createServer, startServer };
