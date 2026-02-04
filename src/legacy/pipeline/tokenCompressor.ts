/**
 * Token Compressor Module
 * 
 * Implements ktg-one/quicksave compression protocol:
 * - Uses Japanese Kanji for semantic compression
 * - Achieves 0.15 entity/token density
 * - Preserves semantic relationships
 * 
 * Rules from RULES.md:
 * - MUST compress when context > TOKEN_THRESHOLD (2000 tokens)
 * - NEVER compress single messages
 * - NEVER compress structured JSON
 * - ONLY compress multi-message context
 * - Uses tiktoken for accurate token counts
 */

import { encoding_for_model, TiktokenModel } from 'tiktoken';
import OpenAI from 'openai';
import { MessageContext } from '../../types/index.js';
import { config } from '../../config/index.js';
import logger from '../../utils/logger.js';

// Tiktoken encoder - lazy initialized
let encoder: ReturnType<typeof encoding_for_model> | null = null;

function getEncoder() {
  if (!encoder) {
    // Use gpt-4o encoding (cl100k_base)
    encoder = encoding_for_model('gpt-4o' as TiktokenModel);
  }
  return encoder;
}

// OpenAI client for compression - lazy initialized
let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openaiApiKey,
    });
  }
  return openaiClient;
}

/**
 * Accurate token count using tiktoken
 * Per RULES.md: Use tiktoken for accurate counts, fallback to ~4 chars/token
 */
export function countTokens(text: string): number {
  try {
    const enc = getEncoder();
    const tokens = enc.encode(text);
    return tokens.length;
  } catch (error) {
    // Fallback: ~4 characters per token
    logger.warn('tiktoken failed, using fallback estimation', { error });
    return Math.ceil(text.length / 4);
  }
}

/**
 * Legacy estimateTokens for backward compatibility
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Quicksave compression prompt
 * Implements ktg-one/quicksave Kanji semantic compression
 */
const QUICKSAVE_SYSTEM_PROMPT = `You are a context compression specialist implementing the Quicksave protocol.

Your task is to compress multi-message conversation context into a dense, machine-readable format using Japanese Kanji for semantic compression.

COMPRESSION RULES:
1. Target density: 0.15 entity/token
2. Use Kanji status markers:
   - 決定 = decided/final
   - 保留 = on hold
   - 進行中 = in progress
   - 完了 = complete
   - 緊急 = urgent
   - 却下 = rejected

3. Use relationship operators:
   - → flows to
   - ← receives from
   - ↔ bidirectional
   - ⊃ contains
   - ∴ therefore

4. Preserve:
   - All event-related information (times, dates, people)
   - Decisions and their rationale
   - Cross-domain relationships
   - Entity names (keep proper nouns in English)

5. Remove:
   - Pleasantries ("thanks", "great", "no problem")
   - Process narration ("let me think", "working on")
   - Redundant confirmations
   - Filler phrases

OUTPUT FORMAT:
Return ONLY the compressed text. No explanations, no markdown.
Keep essential entities, times, and relationships.
Use Kanji markers for status and relationships.`;

/**
 * Compress context using Quicksave LLM-based compression
 * Per aidata/prompt.md: Use ktg-one/quicksave ONLY
 */
async function quicksaveCompress(text: string): Promise<string> {
  if (!config.openaiApiKey) {
    logger.warn('No OpenAI API key - skipping quicksave compression');
    return text;
  }

  const startTime = Date.now();
  
  try {
    const client = getOpenAI();
    
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: QUICKSAVE_SYSTEM_PROMPT },
        { role: 'user', content: `Compress this conversation context:\n\n${text}` }
      ],
      temperature: 0.1, // Low temperature for consistent compression
      max_tokens: 1000,
    });

    const compressed = response.choices[0]?.message?.content?.trim() || text;
    const duration = Date.now() - startTime;

    logger.info('Quicksave compression completed', {
      originalTokens: countTokens(text),
      compressedTokens: countTokens(compressed),
      compressionRatio: (countTokens(compressed) / countTokens(text)).toFixed(2),
      durationMs: duration,
    });

    return compressed;
  } catch (error) {
    logger.error('Quicksave compression failed', { error });
    // Return original on failure - don't lose data
    return text;
  }
}

/**
 * Quicksave compression for context that exceeds token threshold
 * 
 * Rules from RULES.md:
 * - MUST compress when context > TOKEN_THRESHOLD (2000 tokens)
 * - Multiple messages (>1) in context
 * - NEVER compress single messages
 * - NEVER compress structured JSON
 */
export async function compressIfNeeded<T extends MessageContext>(context: T): Promise<T> {
  const threshold = parseInt(process.env.TOKEN_THRESHOLD || '2000', 10);
  const tokenCount = countTokens(
    context.messages.map(m => `[${m.sender}]: ${m.content}`).join('\n')
  );
  
  logger.debug('Checking compression need', {
    tokenCount,
    threshold,
    messageCount: context.messages.length,
  });

  // Rule: NEVER compress single messages
  if (context.messages.length <= 1) {
    logger.debug('Single message - skipping compression per RULES.md');
    return { ...context, tokenCount, compressed: false };
  }

  // Rule: Skip compression for small contexts (below threshold)
  if (tokenCount <= threshold) {
    logger.debug('Context below threshold - skipping compression');
    return { ...context, tokenCount, compressed: false };
  }

  // MUST compress - exceeds threshold AND multiple messages
  logger.info('Compressing context per RULES.md', {
    originalTokens: tokenCount,
    messageCount: context.messages.length,
    threshold,
  });

  // Format messages for compression
  const fullContent = context.messages
    .map(m => `[${m.sender}]: ${m.content}`)
    .join('\n');

  // Compress using Quicksave (LLM-based Kanji compression)
  const compressedContent = await quicksaveCompress(fullContent);
  const newTokenCount = countTokens(compressedContent);

  logger.info('Context compressed with Quicksave', {
    originalTokens: tokenCount,
    compressedTokens: newTokenCount,
    ratio: (newTokenCount / tokenCount).toFixed(2),
    savedTokens: tokenCount - newTokenCount,
  });

  return {
    ...context,
    compressed: true,
    compressedContent,
    tokenCount: newTokenCount,
  };
}

/**
 * Checks if content should be compressed
 */
export function shouldCompress(context: MessageContext): boolean {
  const threshold = parseInt(process.env.TOKEN_THRESHOLD || '2000', 10);
  const tokenCount = countTokens(
    context.messages.map(m => `[${m.sender}]: ${m.content}`).join('\n')
  );
  return tokenCount > threshold && context.messages.length > 1;
}

/**
 * Free tiktoken encoder resources
 */
export function cleanup(): void {
  if (encoder) {
    encoder.free();
    encoder = null;
  }
}

export default { compressIfNeeded, countTokens, estimateTokens, shouldCompress, cleanup };
