/**
 * Pipeline Step Logger
 * 
 * Logs each pipeline step to separate files with newest entries at top.
 * Makes it easy to see what's happening in the AI flow.
 */

import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs', 'pipeline');

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

/**
 * Get IST timestamp
 */
function getIST(): string {
  return new Date().toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Prepend log entry to file (newest at top)
 */
function prependToFile(filename: string, entry: string): void {
  const filepath = path.join(LOGS_DIR, filename);
  
  try {
    let existing = '';
    if (fs.existsSync(filepath)) {
      existing = fs.readFileSync(filepath, 'utf-8');
    }
    
    // Keep only last 500 entries (roughly)
    const lines = existing.split('\n---\n');
    if (lines.length > 500) {
      existing = lines.slice(0, 500).join('\n---\n');
    }
    
    fs.writeFileSync(filepath, entry + '\n---\n' + existing);
  } catch (error) {
    console.error('Failed to write pipeline log:', error);
  }
}

/**
 * Format object for logging
 */
function formatData(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

// =============================================
// Pipeline Step Loggers
// =============================================

export interface PipelineLogContext {
  messageId: string;
  sender?: string;
  chatId?: string;
  content?: string;
}

/**
 * Log incoming webhook
 */
export function logWebhook(ctx: PipelineLogContext, event: string, payload: unknown): void {
  const entry = `[${getIST()}] WEBHOOK RECEIVED
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Chat: ${ctx.chatId || 'Unknown'}
Event: ${event}
Content: ${ctx.content?.substring(0, 200) || 'N/A'}
Raw Payload:
${formatData(payload)}`;
  
  prependToFile('01-webhook.log', entry);
}

/**
 * Log heuristic gate result
 */
export function logHeuristic(ctx: PipelineLogContext, result: {
  hasSignal: boolean;
  signals: string[];
  score: number;
}): void {
  const status = result.hasSignal ? '[PASSED]' : '[DROPPED]';
  
  const entry = `[${getIST()}] HEURISTIC GATE ${status}
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Content: ${ctx.content?.substring(0, 200) || 'N/A'}
Score: ${result.score}
Signals Found: ${result.signals.join(', ') || 'None'}
Decision: ${result.hasSignal ? 'Continue to AI classification' : 'Message dropped (no scheduling signals)'}`;
  
  prependToFile('02-heuristic.log', entry);
}

/**
 * Log AI classification result
 */
export function logClassification(ctx: PipelineLogContext, result: {
  event_type: string;
  confidence: number;
}): void {
  const status = result.event_type !== 'irrelevant' ? '[RELEVANT]' : '[IRRELEVANT]';
  
  const entry = `[${getIST()}] AI CLASSIFICATION ${status}
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Content: ${ctx.content?.substring(0, 200) || 'N/A'}
Event Type: ${result.event_type}
Confidence: ${(result.confidence * 100).toFixed(1)}%
Decision: ${result.event_type !== 'irrelevant' ? 'Continue to extraction' : 'Message classified as irrelevant'}`;
  
  prependToFile('03-classification.log', entry);
}

/**
 * Log context building
 */
export function logContext(ctx: PipelineLogContext, context: {
  messageCount: number;
  tokenCount: number;
  compressed: boolean;
}): void {
  const entry = `[${getIST()}] CONTEXT BUILT
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Messages in Context: ${context.messageCount}
Token Count: ${context.tokenCount}
Compressed: ${context.compressed ? 'Yes' : 'No'}`;
  
  prependToFile('04-context.log', entry);
}

/**
 * Log AI extraction result
 */
export function logExtraction(ctx: PipelineLogContext, result: {
  event_type: string;
  title: string | null;
  start_time: string | null;
  end_time: string | null;
  condition: { type: string | null; value: string | null };
  confidence: number;
}): void {
  const status = result.event_type !== 'irrelevant' && result.confidence >= 0.3 
    ? '[EXTRACTED]' : '[NOT EXTRACTED]';
  
  const entry = `[${getIST()}] AI EXTRACTION ${status}
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Content: ${ctx.content?.substring(0, 200) || 'N/A'}

EXTRACTED EVENT:
  Type: ${result.event_type}
  Title: ${result.title || 'N/A'}
  Start Time: ${result.start_time || 'N/A'}
  End Time: ${result.end_time || 'N/A'}
  Condition: ${result.condition?.type || 'None'} - ${result.condition?.value || 'N/A'}
  Confidence: ${(result.confidence * 100).toFixed(1)}%`;
  
  prependToFile('05-extraction.log', entry);
}

/**
 * Log event routing/storage
 */
export function logRouting(ctx: PipelineLogContext, event: {
  id: string;
  title: string | null;
  status: string;
  contact_name?: string;
}): void {
  const entry = `[${getIST()}] EVENT STORED [OK]
Message ID: ${ctx.messageId}
Event ID: ${event.id}
Title: ${event.title || 'N/A'}
Status: ${event.status}
Contact: ${event.contact_name || ctx.sender || 'Unknown'}
Sender: ${ctx.sender || 'Unknown'}`;
  
  prependToFile('06-events.log', entry);
}

/**
 * Log pipeline error
 */
export function logError(ctx: PipelineLogContext, step: string, error: unknown): void {
  const entry = `[${getIST()}] [ERROR] at ${step}
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Content: ${ctx.content?.substring(0, 200) || 'N/A'}
Error: ${error instanceof Error ? error.message : String(error)}
Stack: ${error instanceof Error ? error.stack : 'N/A'}`;
  
  prependToFile('00-errors.log', entry);
}

/**
 * Log pipeline summary
 */
export function logSummary(ctx: PipelineLogContext, result: 'success' | 'dropped' | 'error', details: string): void {
  const status = result === 'success' ? '[OK]' : result === 'dropped' ? '[SKIP]' : '[ERR]';
  
  const entry = `[${getIST()}] ${status} ${result.toUpperCase()}
Message ID: ${ctx.messageId}
Sender: ${ctx.sender || 'Unknown'}
Content: ${ctx.content?.substring(0, 100) || 'N/A'}...
Result: ${details}`;
  
  prependToFile('07-summary.log', entry);
}

export default {
  logWebhook,
  logHeuristic,
  logClassification,
  logContext,
  logExtraction,
  logRouting,
  logError,
  logSummary,
};
