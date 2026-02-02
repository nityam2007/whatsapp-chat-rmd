/**
 * Shared utilities used across containers
 */

import { nanoid } from 'nanoid';

/**
 * Generates a unique ID
 */
export function generateId(prefix?: string): string {
  const id = nanoid();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Generates a correlation ID for request tracking
 */
export function generateCorrelationId(): string {
  return `corr_${nanoid(12)}`;
}

/**
 * Gets current ISO timestamp
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Safely parses JSON
 */
export function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Delays execution
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await delay(delayMs);
      }
    }
  }
  
  throw lastError;
}

/**
 * Validates ISO-8601 date string
 */
export function isValidISODate(dateString: string): boolean {
  const date = new Date(dateString);
  return !isNaN(date.getTime());
}

/**
 * Parses and normalizes ISO date
 */
export function normalizeISODate(dateString: string | null): string | null {
  if (!dateString) return null;
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}
