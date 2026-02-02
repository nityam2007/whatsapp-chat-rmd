/**
 * Dashboard Router
 * 
 * API endpoints for the admin dashboard.
 */

import { Router, Request, Response } from 'express';
import { ContainerManager } from './containerManager.js';
import { NotificationService } from './notificationService.js';
import { now } from '../shared/utils.js';
import logger from '../utils/logger.js';

export class DashboardRouter {
  public router: Router;
  private containerManager: ContainerManager;
  private notificationService: NotificationService;

  constructor(
    containerManager: ContainerManager,
    notificationService: NotificationService
  ) {
    this.router = Router();
    this.containerManager = containerManager;
    this.notificationService = notificationService;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Dashboard overview
    this.router.get('/overview', async (_req: Request, res: Response) => {
      try {
        const containers = await this.containerManager.listContainers();
        
        const overview = {
          timestamp: now(),
          containers: {
            total: containers.length,
            running: containers.filter(c => c.status === 'running').length,
            stopped: containers.filter(c => c.status === 'stopped').length,
            error: containers.filter(c => c.status === 'error').length,
          },
          notifications: {
            subscriptions: this.notificationService.getSubscriptionCount(),
            recentCount: this.notificationService.getHistory(undefined, 100).length,
          },
        };

        res.json({ success: true, data: overview });
      } catch (error) {
        logger.error('Dashboard overview error', { error });
        res.status(500).json({ success: false, error: 'Failed to get overview' });
      }
    });

    // Container list with details
    this.router.get('/containers', async (_req: Request, res: Response) => {
      try {
        const containers = await this.containerManager.listContainers();
        res.json({ success: true, data: containers });
      } catch (error) {
        logger.error('List containers error', { error });
        res.status(500).json({ success: false, error: 'Failed to list containers' });
      }
    });

    // Container details
    this.router.get('/containers/:id', async (req: Request, res: Response) => {
      try {
        const containers = await this.containerManager.listContainers();
        const container = containers.find(c => c.id === req.params.id);
        
        if (!container) {
          res.status(404).json({ success: false, error: 'Container not found' });
          return;
        }
        
        res.json({ success: true, data: container });
      } catch (error) {
        logger.error('Get container error', { error });
        res.status(500).json({ success: false, error: 'Failed to get container' });
      }
    });

    // Container actions
    this.router.post('/containers/:id/stop', async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        await this.containerManager.stopContainer(id);
        res.json({ success: true });
      } catch (error) {
        logger.error('Stop container error', { error });
        res.status(500).json({ success: false, error: 'Failed to stop container' });
      }
    });

    this.router.post('/containers/:id/restart', async (req: Request, res: Response) => {
      try {
        const id = req.params.id as string;
        await this.containerManager.restartContainer(id);
        res.json({ success: true });
      } catch (error) {
        logger.error('Restart container error', { error });
        res.status(500).json({ success: false, error: 'Failed to restart container' });
      }
    });

    // Notification history
    this.router.get('/notifications', (req: Request, res: Response) => {
      try {
        const userId = req.query.userId as string | undefined;
        const limit = parseInt(req.query.limit as string) || 50;
        
        const history = this.notificationService.getHistory(userId, limit);
        res.json({ success: true, data: history });
      } catch (error) {
        logger.error('Get notifications error', { error });
        res.status(500).json({ success: false, error: 'Failed to get notifications' });
      }
    });

    // Send test notification
    this.router.post('/notifications/test', async (req: Request, res: Response) => {
      try {
        const { userId, title, body } = req.body;
        
        if (!userId) {
          res.status(400).json({ success: false, error: 'userId is required' });
          return;
        }
        
        const success = await this.notificationService.sendToUser(userId, {
          type: 'system',
          title: title || 'Test Notification',
          body: body || 'This is a test notification from the dashboard.',
        });
        
        res.json({ success, message: success ? 'Notification sent' : 'No subscriptions found' });
      } catch (error) {
        logger.error('Test notification error', { error });
        res.status(500).json({ success: false, error: 'Failed to send notification' });
      }
    });

    // Broadcast notification
    this.router.post('/notifications/broadcast', async (req: Request, res: Response) => {
      try {
        const { title, body } = req.body;
        
        if (!title || !body) {
          res.status(400).json({ success: false, error: 'title and body are required' });
          return;
        }
        
        const sentCount = await this.notificationService.broadcast({
          type: 'system',
          title,
          body,
        });
        
        res.json({ success: true, sentCount });
      } catch (error) {
        logger.error('Broadcast notification error', { error });
        res.status(500).json({ success: false, error: 'Failed to broadcast' });
      }
    });

    // User statistics
    this.router.get('/stats', async (_req: Request, res: Response) => {
      try {
        const containers = await this.containerManager.listContainers();
        
        // Calculate stats
        const stats = {
          timestamp: now(),
          users: {
            total: containers.length,
            active: containers.filter(c => c.status === 'running').length,
          },
          uptime: process.uptime(),
          memory: process.memoryUsage(),
        };
        
        res.json({ success: true, data: stats });
      } catch (error) {
        logger.error('Get stats error', { error });
        res.status(500).json({ success: false, error: 'Failed to get stats' });
      }
    });
  }
}

export default DashboardRouter;
