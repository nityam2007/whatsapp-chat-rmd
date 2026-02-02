/**
 * Express Server Setup
 * 
 * Main API server with comprehensive endpoints for:
 * - Events management (CRUD, accept/decline)
 * - Messages viewing
 * - Contacts
 * - Dashboard stats
 * - Pipeline logs
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { webhookRouter } from './webhook/evolution.js';
import { config } from './config/index.js';
import { 
  getAllContacts, 
  getTopContacts, 
  getEventsByContact, 
  getISTTimestamp,
  getMessages,
  getEvents,
  getEventById,
  updateEventStatus,
  deleteEvent,
  getUpcomingEvents,
  getEventStats,
  getMessageStats,
  archiveOldData,
  getArchiveMetadata,
  getPipelineLogs,
} from './database/sqlite.js';
import logger from './utils/logger.js';
import { metrics } from './utils/metrics.js';
import {
  getPatternLearningStats,
  getAllLearnedPatterns,
  getLLMExtractionLogs,
  runPatternLearning,
  deactivatePattern,
} from './pipeline/patternLearner.js';
import { getLearnedPatternCounts } from './pipeline/ruleEngine.js';

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
      name: 'WhatsApp Chat RMD',
      version: '0.4.0',
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
      const topContacts = getTopContacts(5);
      
      res.json({
        events: eventStats,
        messages: messageStats,
        upcoming: upcomingEvents,
        topContacts,
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
  // Contacts API
  // =============================================
  
  app.get('/api/contacts', apiAuth, (_req: Request, res: Response) => {
    try {
      const contacts = getAllContacts();
      res.json({ 
        contacts, 
        count: contacts.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to list contacts', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/contacts/top', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const contacts = getTopContacts(limit);
      res.json({ 
        contacts, 
        count: contacts.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get top contacts', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/contacts/:name/events', apiAuth, (req: Request, res: Response) => {
    try {
      const name = req.params.name as string;
      const events = getEventsByContact(name);
      res.json({ 
        contactName: name,
        events, 
        count: events.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get events by contact', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // =============================================
  // Notifications API
  // =============================================
  
  app.get('/api/notifications', apiAuth, (_req: Request, res: Response) => {
    res.json({ notifications: getNotificationHistory() });
  });

  // =============================================
  // Pipeline Logs API
  // =============================================
  
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

  // List available log files
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
  // Pattern Learning API (Auto-Learning System)
  // =============================================
  
  // Get pattern learning statistics
  app.get('/api/learning/stats', apiAuth, (_req: Request, res: Response) => {
    try {
      const stats = getPatternLearningStats();
      const loadedPatterns = getLearnedPatternCounts();
      
      res.json({
        stats,
        loadedPatterns,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get pattern learning stats', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get all learned patterns
  app.get('/api/learning/patterns', apiAuth, (_req: Request, res: Response) => {
    try {
      const patterns = getAllLearnedPatterns();
      
      res.json({
        patterns,
        count: patterns.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get learned patterns', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get LLM extraction logs (for debugging)
  app.get('/api/learning/logs', apiAuth, (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const minConfidence = parseFloat(req.query.minConfidence as string) || 0.5;
      const eventType = req.query.eventType as string | undefined;
      
      const logs = getLLMExtractionLogs({ limit, minConfidence, eventType });
      
      res.json({
        logs,
        count: logs.length,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to get LLM extraction logs', { error });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Trigger pattern learning manually
  app.post('/api/learning/run', apiAuth, async (_req: Request, res: Response) => {
    try {
      logger.info('Manual pattern learning triggered');
      const result = await runPatternLearning();
      
      res.json({
        message: 'Pattern learning completed',
        ...result,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Pattern learning failed', { error });
      res.status(500).json({ error: 'Pattern learning failed' });
    }
  });

  // Deactivate a learned pattern
  app.delete('/api/learning/patterns/:patternId', apiAuth, (req: Request, res: Response) => {
    try {
      const patternId = req.params.patternId as string;
      deactivatePattern(patternId);
      
      logger.info('Pattern deactivated via API', { patternId });
      res.json({
        message: 'Pattern deactivated',
        patternId,
        timestamp: getISTTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to deactivate pattern', { error, patternId: req.params.patternId });
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
╔═══════════════════════════════════════════════════════════════════╗
║                     WhatsApp Chat RMD v0.5.0                      ║
║                      (Auto-Learning Enabled)                      ║
╠═══════════════════════════════════════════════════════════════════╣
║  Server: http://localhost:${String(config.port).padEnd(5)}                                  ║
║  Environment: ${config.nodeEnv.padEnd(52)}║
║  Timezone: ${config.timezone.padEnd(55)}║
╠═══════════════════════════════════════════════════════════════════╣
║  API Endpoints:                                                   ║
║    GET  /                         - Health check                  ║
║    POST /webhook/evolution        - WhatsApp webhook              ║
║    POST /webhook/test             - Test message                  ║
║                                                                   ║
║    GET  /api/dashboard/stats      - Dashboard statistics          ║
║    GET  /api/data/stats           - Data collection stats         ║
║    GET  /api/metrics              - Pipeline metrics (full)       ║
║    GET  /api/metrics/summary      - Pipeline metrics (summary)    ║
║                                                                   ║
║    GET  /api/events               - List events                   ║
║    GET  /api/events/:id           - Get event                     ║
║    POST /api/events/:id/accept    - Accept event                  ║
║    POST /api/events/:id/decline   - Decline event                 ║
║    POST /api/events/:id/snooze    - Snooze event                  ║
║    POST /api/events/:id/complete  - Complete event                ║
║    DEL  /api/events/:id           - Delete event                  ║
║                                                                   ║
║    GET  /api/messages             - List messages                 ║
║    GET  /api/contacts             - List contacts                 ║
║    GET  /api/logs                 - List pipeline logs            ║
║    GET  /api/logs/:step           - Get specific log              ║
║    GET  /api/pipeline/:messageId  - Get pipeline data for message ║
║                                                                   ║
║    GET  /api/archive              - List archives                 ║
║    POST /api/archive              - Trigger manual archive        ║
║                                                                   ║
║  Auto-Learning API:                                               ║
║    GET  /api/learning/stats       - Pattern learning statistics   ║
║    GET  /api/learning/patterns    - List learned patterns         ║
║    GET  /api/learning/logs        - LLM extraction logs           ║
║    POST /api/learning/run         - Trigger pattern learning      ║
║    DEL  /api/learning/patterns/:id - Deactivate pattern           ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
  });
}

export default { createServer, startServer };
