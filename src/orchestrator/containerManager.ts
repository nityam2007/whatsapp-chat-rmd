/**
 * Container Manager
 * 
 * Manages Docker containers for each user.
 * Handles container lifecycle, health monitoring, and scaling.
 */

import { Redis } from 'ioredis';
import { User, ContainerInfo } from '../shared/types.js';
import { generateId, now } from '../shared/utils.js';
import logger from '../utils/logger.js';
import { config } from '../config/index.js';

export class ContainerManager {
  private redis: Redis;
  private containers: Map<string, ContainerInfo> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(redis: Redis) {
    this.redis = redis;
    this.startHealthMonitoring();
  }

  /**
   * Creates a new user and their container
   */
  async createUserContainer(phone: string, email?: string): Promise<User> {
    const userId = generateId('user');
    const containerId = generateId('container');

    logger.info('Creating user container', { userId, phone });

    // Create container info
    const containerInfo: ContainerInfo = {
      id: containerId,
      userId,
      status: 'creating',
      port: await this.allocatePort(),
      hostname: `rmd-${userId}`,
      createdAt: now(),
    };

    // Store in memory and Redis
    this.containers.set(containerId, containerInfo);
    await this.redis.hset(`container:${containerId}`, containerInfo as unknown as Record<string, string>);

    // Create user
    const user: User = {
      id: userId,
      phone,
      email,
      containerId,
      containerStatus: 'creating',
      createdAt: now(),
      lastActiveAt: now(),
    };

    await this.redis.hset(`user:${userId}`, user as unknown as Record<string, string>);

    // Start the container (async)
    this.startContainer(containerInfo)
      .then(() => {
        containerInfo.status = 'running';
        user.containerStatus = 'running';
        this.redis.hset(`container:${containerId}`, 'status', 'running');
        this.redis.hset(`user:${userId}`, 'containerStatus', 'running');
      })
      .catch((error) => {
        logger.error('Failed to start container', { error, containerId });
        containerInfo.status = 'error';
        user.containerStatus = 'error';
        this.redis.hset(`container:${containerId}`, 'status', 'error');
        this.redis.hset(`user:${userId}`, 'containerStatus', 'error');
      });

    return user;
  }

  /**
   * Starts a Docker container
   */
  private async startContainer(info: ContainerInfo): Promise<void> {
    logger.info('Starting container', { containerId: info.id, port: info.port });

    // In production, this would use Docker API or docker-compose
    // For now, we simulate container creation
    
    if (config.nodeEnv === 'production') {
      // Use Docker API
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const dockerCommand = `docker run -d \
        --name ${info.hostname} \
        --network rmd-network \
        -p ${info.port}:3000 \
        -e USER_ID=${info.userId} \
        -e ORCHESTRATOR_URL=http://orchestrator:4000 \
        -e REDIS_URL=${config.redisUrl} \
        -v rmd-data-${info.userId}:/app/data \
        whatsapp-rmd:latest`;

      await execAsync(dockerCommand);
    } else {
      // Development mode - simulate delay
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    info.status = 'running';
    logger.info('Container started', { containerId: info.id });
  }

  /**
   * Stops a container
   */
  async stopContainer(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found`);
    }

    logger.info('Stopping container', { containerId });

    if (config.nodeEnv === 'production') {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      await execAsync(`docker stop ${container.hostname}`);
      await execAsync(`docker rm ${container.hostname}`);
    }

    container.status = 'stopped';
    await this.redis.hset(`container:${containerId}`, 'status', 'stopped');
  }

  /**
   * Restarts a container
   */
  async restartContainer(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (!container) {
      throw new Error(`Container ${containerId} not found`);
    }

    logger.info('Restarting container', { containerId });

    await this.stopContainer(containerId);
    await this.startContainer(container);
  }

  /**
   * Gets user by ID
   */
  async getUser(userId: string): Promise<User | null> {
    const data = await this.redis.hgetall(`user:${userId}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return data as unknown as User;
  }

  /**
   * Lists all containers
   */
  async listContainers(): Promise<ContainerInfo[]> {
    return Array.from(this.containers.values());
  }

  /**
   * Gets active container count
   */
  getActiveCount(): number {
    return Array.from(this.containers.values())
      .filter(c => c.status === 'running')
      .length;
  }

  /**
   * Records a health check from a container
   */
  async recordHealthCheck(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (container) {
      container.lastHealthCheck = now();
      await this.redis.hset(`container:${containerId}`, 'lastHealthCheck', container.lastHealthCheck);
    }
  }

  /**
   * Allocates a unique port for a new container
   */
  private async allocatePort(): Promise<number> {
    const basePort = 3100;
    const usedPorts = new Set(
      Array.from(this.containers.values()).map(c => c.port)
    );

    for (let port = basePort; port < basePort + 1000; port++) {
      if (!usedPorts.has(port)) {
        return port;
      }
    }

    throw new Error('No available ports');
  }

  /**
   * Starts health monitoring for all containers
   */
  private startHealthMonitoring(): void {
    const checkInterval = 30000; // 30 seconds

    this.healthCheckInterval = setInterval(async () => {
      for (const [containerId, container] of this.containers) {
        if (container.status !== 'running') continue;

        const lastCheck = container.lastHealthCheck 
          ? new Date(container.lastHealthCheck).getTime()
          : 0;
        const now = Date.now();

        // If no health check in 2 minutes, mark as unhealthy
        if (now - lastCheck > 120000) {
          logger.warn('Container unhealthy', { containerId, lastCheck: container.lastHealthCheck });
          
          // Attempt restart
          try {
            await this.restartContainer(containerId);
          } catch (error) {
            logger.error('Failed to restart unhealthy container', { error, containerId });
          }
        }
      }
    }, checkInterval);
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Stop all containers
    for (const containerId of this.containers.keys()) {
      try {
        await this.stopContainer(containerId);
      } catch (error) {
        logger.error('Failed to stop container during shutdown', { error, containerId });
      }
    }
  }
}

export default ContainerManager;
