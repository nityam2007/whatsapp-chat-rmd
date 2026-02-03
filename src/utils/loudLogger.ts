/**
 * LOUD LOGGER - High visibility logging for debugging
 * 
 * This logger:
 * - Prints to console with clear prefixes and separators
 * - Writes to log files (data/logs/)
 * - YELLS when there are errors
 * - Stores critical data in database
 * 
 * RULE: Add logs at EVERY step. When in doubt, log it.
 */

import fs from 'fs';
import path from 'path';

// Colors for console
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
};

// Log directory
const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

// Ensure log directory exists
function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

// Get IST timestamp
function getTimestamp(): string {
  return new Date().toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    hour12: false,
  });
}

// Write to file
function writeToFile(filename: string, content: string): void {
  ensureLogDir();
  const filepath = path.join(LOG_DIR, filename);
  const line = `[${getTimestamp()}] ${content}\n`;
  fs.appendFileSync(filepath, line);
}

// ============================================================================
// LOUD LOGGING FUNCTIONS
// ============================================================================

/**
 * Log pipeline step - visible step marker
 */
export function logStep(step: string, messageId: string, data?: Record<string, unknown>): void {
  const prefix = `${C.cyan}[STEP]${C.reset}`;
  const msg = `${prefix} ${C.bright}${step}${C.reset} | msg=${messageId.slice(0, 15)}...`;
  console.log(msg);
  if (data) {
    console.log(`       ${C.dim}${JSON.stringify(data)}${C.reset}`);
  }
  writeToFile('pipeline.log', `[STEP] ${step} | msg=${messageId} | ${JSON.stringify(data || {})}`);
}

/**
 * Log LLM call - input and output
 */
export function logLLM(
  type: 'classification' | 'extraction',
  messageId: string,
  input: {
    model: string;
    provider: string;
    prompt: string;
  },
  output?: {
    response?: string;
    parsed?: unknown;
    finishReason?: string;
    tokens?: number;
    durationMs?: number;
    error?: string;
  }
): void {
  const prefix = `${C.magenta}[LLM:${type.toUpperCase()}]${C.reset}`;
  
  // Console log
  console.log(`\n${prefix} ${C.bright}API CALL${C.reset} | msg=${messageId.slice(0, 15)}...`);
  console.log(`  ${C.blue}Model:${C.reset} ${input.model} (${input.provider})`);
  console.log(`  ${C.blue}Prompt:${C.reset} ${input.prompt.slice(0, 100)}...`);
  
  if (output) {
    if (output.error) {
      console.log(`  ${C.red}${C.bright}ERROR:${C.reset} ${C.red}${output.error}${C.reset}`);
    } else {
      console.log(`  ${C.green}Response:${C.reset} ${output.response?.slice(0, 100) || 'EMPTY'}`);
      console.log(`  ${C.green}Parsed:${C.reset} ${JSON.stringify(output.parsed)}`);
      console.log(`  ${C.dim}Finish: ${output.finishReason} | Tokens: ${output.tokens} | ${output.durationMs}ms${C.reset}`);
    }
  }
  
  // File log
  writeToFile('llm.log', JSON.stringify({
    type,
    messageId,
    timestamp: getTimestamp(),
    input: { model: input.model, provider: input.provider, promptLength: input.prompt.length },
    output: output ? {
      responseLength: output.response?.length || 0,
      parsed: output.parsed,
      finishReason: output.finishReason,
      tokens: output.tokens,
      durationMs: output.durationMs,
      error: output.error,
    } : null,
  }));
  
  // Full prompt/response log (separate file for detailed analysis)
  writeToFile('llm-full.log', `
=== ${type.toUpperCase()} | ${messageId} | ${getTimestamp()} ===
MODEL: ${input.model} (${input.provider})
--- PROMPT ---
${input.prompt}
--- RESPONSE ---
${output?.response || 'NO RESPONSE'}
--- PARSED ---
${JSON.stringify(output?.parsed, null, 2)}
--- META ---
Finish: ${output?.finishReason} | Tokens: ${output?.tokens} | Duration: ${output?.durationMs}ms | Error: ${output?.error || 'none'}
${'='.repeat(60)}
`);
}

/**
 * Log success - green checkmark
 */
export function logSuccess(component: string, message: string, data?: Record<string, unknown>): void {
  const prefix = `${C.green}[✓ ${component}]${C.reset}`;
  console.log(`${prefix} ${message}`);
  if (data) {
    console.log(`  ${C.dim}${JSON.stringify(data)}${C.reset}`);
  }
  writeToFile('pipeline.log', `[SUCCESS] ${component}: ${message} | ${JSON.stringify(data || {})}`);
}

/**
 * Log warning - yellow
 */
export function logWarn(component: string, message: string, data?: Record<string, unknown>): void {
  const prefix = `${C.yellow}[⚠ ${component}]${C.reset}`;
  console.log(`${prefix} ${C.yellow}${message}${C.reset}`);
  if (data) {
    console.log(`  ${C.dim}${JSON.stringify(data)}${C.reset}`);
  }
  writeToFile('pipeline.log', `[WARN] ${component}: ${message} | ${JSON.stringify(data || {})}`);
  writeToFile('warnings.log', `${component}: ${message} | ${JSON.stringify(data || {})}`);
}

/**
 * YELL ERROR - Very visible error logging
 */
export function logError(component: string, message: string, error?: unknown, data?: Record<string, unknown>): void {
  const errorStr = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  
  // LOUD console output
  console.log('\n' + '!'.repeat(70));
  console.log(`${C.bgRed}${C.bright} ERROR ${C.reset} ${C.red}${C.bright}${component}${C.reset}`);
  console.log('!'.repeat(70));
  console.log(`${C.red}${message}${C.reset}`);
  if (errorStr) {
    console.log(`${C.red}Error: ${errorStr}${C.reset}`);
  }
  if (data) {
    console.log(`${C.red}Data: ${JSON.stringify(data)}${C.reset}`);
  }
  if (stack) {
    console.log(`${C.dim}${stack}${C.reset}`);
  }
  console.log('!'.repeat(70) + '\n');
  
  // File logs
  writeToFile('errors.log', `
${'!'.repeat(60)}
[${getTimestamp()}] ${component}: ${message}
Error: ${errorStr}
Data: ${JSON.stringify(data || {})}
Stack: ${stack || 'N/A'}
${'!'.repeat(60)}
`);
  writeToFile('pipeline.log', `[ERROR] ${component}: ${message} | ${errorStr}`);
}

/**
 * Log data point - for data collection
 */
export function logData(category: string, data: Record<string, unknown>): void {
  const prefix = `${C.blue}[DATA:${category}]${C.reset}`;
  console.log(`${prefix} ${C.dim}${JSON.stringify(data).slice(0, 100)}...${C.reset}`);
  writeToFile(`data-${category}.log`, JSON.stringify({ timestamp: getTimestamp(), ...data }));
}

/**
 * Log message flow - track message through pipeline
 */
export function logMessageFlow(messageId: string, stage: string, status: 'start' | 'end' | 'skip' | 'error', details?: string): void {
  const icons: Record<string, string> = {
    start: '→',
    end: '✓',
    skip: '⊘',
    error: '✗',
  };
  const colors: Record<string, string> = {
    start: C.cyan,
    end: C.green,
    skip: C.yellow,
    error: C.red,
  };
  
  const icon = icons[status] || '?';
  const color = colors[status] || C.reset;
  
  console.log(`${color}[${icon}]${C.reset} ${messageId.slice(0, 12)}... ${C.bright}${stage}${C.reset} ${details ? `(${details})` : ''}`);
  writeToFile('message-flow.log', `${messageId} | ${stage} | ${status} | ${details || ''}`);
}

/**
 * Separator for visual clarity
 */
export function logSeparator(title?: string): void {
  if (title) {
    console.log(`\n${C.cyan}${'─'.repeat(20)} ${title} ${'─'.repeat(20)}${C.reset}`);
  } else {
    console.log(`${C.dim}${'─'.repeat(50)}${C.reset}`);
  }
}

export default {
  logStep,
  logLLM,
  logSuccess,
  logWarn,
  logError,
  logData,
  logMessageFlow,
  logSeparator,
};
