import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

export interface Config {
  // Server
  port: number;
  nodeEnv: string;
  
  // Timezone
  timezone: string;
  
  // Orchestrator
  orchestratorPort: number;
  orchestratorUrl: string;

  // Database
  databasePath: string;

  // Vector Store
  faissIndexPath: string;

  // Redis
  redisUrl: string;

  // OpenAI (for embeddings)
  openaiApiKey: string;
  openaiEmbeddingModel: string;

  // Gemini (for LLM - OpenAI compatible)
  geminiApiKey: string;
  geminiModel: string;
  geminiApiUrl: string;

  // Evolution API
  evolutionApiUrl: string;
  evolutionApiKey: string;
  evolutionInstance: string;  // WhatsApp instance name

  // Proactive Trigger Settings
  enableProactiveTriggers: boolean;
  proactiveCheckInterval: number;  // Interval in ms for cron checks

  // Heuristic Gate
  heuristicThreshold: number;

  // Web Push
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidEmail: string;

  // Logging
  logLevel: string;

  // User Container
  userId: string;
  containerId: string;
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    return '';
  }
  return value;
}

function getEnvVarInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const config: Config = {
  // Server
  port: getEnvVarInt('PORT', 3000),
  nodeEnv: getEnvVar('NODE_ENV', 'development'),
  
  // Timezone - default to IST (Asia/Kolkata)
  timezone: getEnvVar('TIMEZONE', 'Asia/Kolkata'),
  
  // Orchestrator
  orchestratorPort: getEnvVarInt('ORCHESTRATOR_PORT', 4000),
  orchestratorUrl: getEnvVar('ORCHESTRATOR_URL', 'http://localhost:4000'),

  // Database
  databasePath: getEnvVar('DATABASE_PATH', path.join(process.cwd(), 'data', 'db', 'events.db')),

  // Vector Store
  faissIndexPath: getEnvVar('FAISS_INDEX_PATH', path.join(process.cwd(), 'data', 'vectors', 'index')),

  // Redis
  redisUrl: getEnvVar('REDIS_URL', 'redis://localhost:6379'),

  // OpenAI (for embeddings)
  openaiApiKey: getEnvVar('OPENAI_API_KEY', ''),
  openaiEmbeddingModel: getEnvVar('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),

  // Gemini (for LLM - OpenAI compatible)
  geminiApiKey: getEnvVar('GEMINI_API_KEY', ''),
  geminiModel: getEnvVar('GEMINI_MODEL', 'gemini-3-flash-preview'),
  geminiApiUrl: getEnvVar('GEMINI_API_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),

  // Evolution API
  evolutionApiUrl: getEnvVar('EVOLUTION_API_URL', 'http://localhost:8080'),
  evolutionApiKey: getEnvVar('EVOLUTION_API_KEY', ''),
  evolutionInstance: getEnvVar('EVOLUTION_INSTANCE', 'default'),

  // Proactive Trigger Settings
  enableProactiveTriggers: getEnvVar('ENABLE_PROACTIVE_TRIGGERS', 'true') === 'true',
  proactiveCheckInterval: getEnvVarInt('PROACTIVE_CHECK_INTERVAL', 60000),  // Default 1 minute

  // Heuristic Gate
  heuristicThreshold: getEnvVarInt('HEURISTIC_THRESHOLD', 1),

  // Web Push
  vapidPublicKey: getEnvVar('VAPID_PUBLIC_KEY', ''),
  vapidPrivateKey: getEnvVar('VAPID_PRIVATE_KEY', ''),
  vapidEmail: getEnvVar('VAPID_EMAIL', 'mailto:admin@example.com'),

  // Logging
  logLevel: getEnvVar('LOG_LEVEL', 'debug'),

  // User Container
  userId: getEnvVar('USER_ID', ''),
  containerId: getEnvVar('CONTAINER_ID', ''),
};

export function validateConfig(): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.openaiApiKey) {
    warnings.push('OPENAI_API_KEY not set - embeddings will use fallback');
  }

  if (!config.redisUrl && config.nodeEnv === 'production') {
    errors.push('REDIS_URL is required in production');
  }

  return errors;
}

export function isProduction(): boolean {
  return config.nodeEnv === 'production';
}

export function isDevelopment(): boolean {
  return config.nodeEnv === 'development';
}

export default config;
