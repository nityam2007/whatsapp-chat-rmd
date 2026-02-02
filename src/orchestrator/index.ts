/**
 * Orchestrator Service
 * 
 * Central service that manages:
 * - User containers
 * - Push notifications to all users
 * - Dashboard API
 * - WebSocket connections for real-time updates
 * - Container health monitoring
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import cors from 'cors';
import { Redis } from 'ioredis';
import { 
  ContainerCommand, 
  ContainerResponse,
  NotificationPayload,
  WsMessage,
  PushSubscriptionData,
} from '../shared/types.js';
import { generateId, generateCorrelationId, now } from '../shared/utils.js';
import { ContainerManager } from './containerManager.js';
import { NotificationService } from './notificationService.js';
import { DashboardRouter } from './dashboardRouter.js';
import logger from '../utils/logger.js';
import { config } from '../config/index.js';

// WebSocket client tracking
interface WsClient {
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>;
}

export class Orchestrator {
  private app: Express;
  private wss: WebSocketServer;
  private redis: Redis;
  private containerManager: ContainerManager;
  private notificationService: NotificationService;
  private wsClients: Map<string, WsClient> = new Map();

  constructor() {
    this.app = express();
    this.redis = new Redis(config.redisUrl);
    this.containerManager = new ContainerManager(this.redis);
    this.notificationService = new NotificationService();
    this.wss = new WebSocketServer({ noServer: true });
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupRedisSubscriber();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    
    // Request logging
    this.app.use((req: Request, _res: Response, next: NextFunction) => {
      logger.debug('Orchestrator request', {
        method: req.method,
        path: req.path,
      });
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({
        service: 'orchestrator',
        status: 'healthy',
        timestamp: now(),
        containers: this.containerManager.getActiveCount(),
        wsClients: this.wsClients.size,
      });
    });

    // Dashboard routes
    const dashboardRouter = new DashboardRouter(
      this.containerManager,
      this.notificationService
    );
    this.app.use('/api/dashboard', dashboardRouter.router);

    // Container command endpoint (from user containers)
    this.app.post('/internal/command', async (req, res) => {
      try {
        const command = req.body as ContainerCommand;
        const response = await this.handleContainerCommand(command);
        res.json(response);
      } catch (error) {
        logger.error('Command handling error', { error });
        res.status(500).json({
          success: false,
          error: 'Internal error',
          correlationId: req.body?.correlationId || 'unknown',
          timestamp: now(),
        });
      }
    });

    // Push notification registration
    this.app.post('/api/push/subscribe', async (req, res) => {
      try {
        const { userId, subscription } = req.body as {
          userId: string;
          subscription: PushSubscriptionData;
        };
        
        await this.notificationService.registerSubscription(userId, subscription);
        
        res.json({ success: true });
      } catch (error) {
        logger.error('Push subscription error', { error });
        res.status(500).json({ success: false, error: 'Failed to register subscription' });
      }
    });

    // Send notification to user
    this.app.post('/api/push/send', async (req, res) => {
      try {
        const { userId, notification } = req.body as {
          userId: string;
          notification: NotificationPayload;
        };
        
        await this.notificationService.sendToUser(userId, notification);
        
        res.json({ success: true });
      } catch (error) {
        logger.error('Send notification error', { error });
        res.status(500).json({ success: false, error: 'Failed to send notification' });
      }
    });

    // User management
    this.app.post('/api/users', async (req, res) => {
      try {
        const { phone, email } = req.body;
        const user = await this.containerManager.createUserContainer(phone, email);
        res.json({ success: true, data: user });
      } catch (error) {
        logger.error('User creation error', { error });
        res.status(500).json({ success: false, error: 'Failed to create user' });
      }
    });

    this.app.get('/api/users/:userId', async (req, res) => {
      try {
        const user = await this.containerManager.getUser(req.params.userId);
        if (!user) {
          res.status(404).json({ success: false, error: 'User not found' });
          return;
        }
        res.json({ success: true, data: user });
      } catch (error) {
        logger.error('Get user error', { error });
        res.status(500).json({ success: false, error: 'Failed to get user' });
      }
    });

    // Container management
    this.app.get('/api/containers', async (_req, res) => {
      try {
        const containers = await this.containerManager.listContainers();
        res.json({ success: true, data: containers });
      } catch (error) {
        logger.error('List containers error', { error });
        res.status(500).json({ success: false, error: 'Failed to list containers' });
      }
    });

    this.app.post('/api/containers/:containerId/restart', async (req, res) => {
      try {
        await this.containerManager.restartContainer(req.params.containerId);
        res.json({ success: true });
      } catch (error) {
        logger.error('Restart container error', { error });
        res.status(500).json({ success: false, error: 'Failed to restart container' });
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, userId: string) => {
      const clientId = generateId('ws');
      
      const client: WsClient = {
        ws,
        userId,
        subscriptions: new Set(),
      };
      
      this.wsClients.set(clientId, client);
      logger.info('WebSocket client connected', { clientId, userId });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString()) as WsMessage;
          this.handleWsMessage(clientId, message);
        } catch (error) {
          logger.error('WebSocket message parse error', { error });
        }
      });

      ws.on('close', () => {
        this.wsClients.delete(clientId);
        logger.info('WebSocket client disconnected', { clientId });
      });

      // Send initial connection confirmation
      this.sendToClient(clientId, {
        type: 'pong',
        payload: { connected: true },
        timestamp: now(),
      });
    });
  }

  private handleWsMessage(clientId: string, message: WsMessage): void {
    const client = this.wsClients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'ping':
        this.sendToClient(clientId, {
          type: 'pong',
          payload: {},
          timestamp: now(),
        });
        break;

      case 'subscribe':
        const topic = message.payload as string;
        client.subscriptions.add(topic);
        break;

      case 'unsubscribe':
        const unsubTopic = message.payload as string;
        client.subscriptions.delete(unsubTopic);
        break;
    }
  }

  private sendToClient(clientId: string, message: WsMessage): void {
    const client = this.wsClients.get(clientId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  private broadcastToUser(userId: string, message: WsMessage): void {
    for (const [_, client] of this.wsClients) {
      if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    }
  }

  private setupRedisSubscriber(): void {
    const subscriber = this.redis.duplicate();
    
    subscriber.subscribe('container:events', (err) => {
      if (err) {
        logger.error('Redis subscribe error', { error: err });
      }
    });

    subscriber.on('message', (channel, message) => {
      if (channel === 'container:events') {
        try {
          const event = JSON.parse(message);
          this.handleContainerEvent(event);
        } catch (error) {
          logger.error('Redis message parse error', { error });
        }
      }
    });
  }

  private async handleContainerEvent(event: {
    type: string;
    userId: string;
    data: unknown;
  }): Promise<void> {
    logger.debug('Container event received', { type: event.type, userId: event.userId });

    // Broadcast to WebSocket clients
    this.broadcastToUser(event.userId, {
      type: event.type as WsMessage['type'],
      payload: event.data,
      userId: event.userId,
      timestamp: now(),
    });

    // Handle specific event types
    switch (event.type) {
      case 'event_created':
      case 'event_updated':
        // Could trigger additional processing here
        break;
    }
  }

  private async handleContainerCommand(command: ContainerCommand): Promise<ContainerResponse> {
    const correlationId = command.correlationId || generateCorrelationId();
    
    logger.info('Handling container command', {
      type: command.type,
      userId: command.userId,
      correlationId,
    });

    try {
      switch (command.type) {
        case 'SEND_NOTIFICATION':
          const notification = command.payload as NotificationPayload;
          await this.notificationService.sendToUser(command.userId, notification);
          
          // Also broadcast via WebSocket
          this.broadcastToUser(command.userId, {
            type: 'notification',
            payload: notification,
            userId: command.userId,
            timestamp: now(),
          });
          break;

        case 'NEW_EVENT':
        case 'UPDATE_EVENT':
        case 'DELETE_EVENT':
          // Broadcast event changes to dashboard
          this.broadcastToUser(command.userId, {
            type: command.type === 'NEW_EVENT' ? 'event_created' :
                  command.type === 'UPDATE_EVENT' ? 'event_updated' : 'event_deleted',
            payload: command.payload,
            userId: command.userId,
            timestamp: now(),
          });
          break;

        case 'REGISTER_PUSH':
          const subscription = command.payload as PushSubscriptionData;
          await this.notificationService.registerSubscription(command.userId, subscription);
          break;

        case 'HEALTH_CHECK':
          await this.containerManager.recordHealthCheck(command.containerId);
          break;

        case 'SYNC_REQUEST':
          // Handle sync request from container
          break;
      }

      return {
        success: true,
        correlationId,
        timestamp: now(),
      };
    } catch (error) {
      logger.error('Container command failed', { error, command });
      return {
        success: false,
        error: String(error),
        correlationId,
        timestamp: now(),
      };
    }
  }

  public start(): void {
    const server = createServer(this.app);
    
    // Handle WebSocket upgrade
    server.on('upgrade', (request, socket, head) => {
      // Extract userId from query or auth header
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const userId = url.searchParams.get('userId') || 'anonymous';
      
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, userId);
      });
    });

    const port = config.orchestratorPort || 4000;
    
    server.listen(port, () => {
      logger.info(`Orchestrator started on port ${port}`);
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║                  Argus - Orchestrator                     ║
║                      Version 0.5.0                        ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${port}                ║
║                                                           ║
║  Endpoints:                                               ║
║    GET  /health              - Health check               ║
║    POST /api/users           - Create user & container    ║
║    GET  /api/containers      - List containers            ║
║    POST /api/push/subscribe  - Register push subscription ║
║    POST /api/push/send       - Send push notification     ║
║    WS   /ws?userId=xxx       - WebSocket connection       ║
║                                                           ║
║  Dashboard: /api/dashboard/*                              ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });
  }
}

// Start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const orchestrator = new Orchestrator();
  orchestrator.start();
}

export default Orchestrator;
