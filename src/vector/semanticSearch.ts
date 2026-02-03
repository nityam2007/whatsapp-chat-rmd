/**
 * Semantic Search Module
 * 
 * Provides semantic similarity search capabilities across the pipeline.
 * Uses embeddings to find similar messages, patterns, and examples.
 * 
 * This module enhances accuracy by:
 * 1. Finding semantically similar past messages for few-shot learning
 * 2. Boosting heuristic scores for messages similar to known event patterns
 * 3. Providing semantic context for extraction
 */

import { generateEmbedding, initVectorStore } from './faiss.js';
import logger from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { config } from '../config/index.js';

// Types
export interface SemanticPattern {
  id: string;
  text: string;
  embedding: number[];
  category: 'event' | 'reminder' | 'deadline' | 'meeting' | 'update' | 'cancel';
  classification: 'new_event' | 'update_event' | 'signal_event' | 'irrelevant';
  confidence: number;
  hitCount: number;
  lastUsed: string;
}

export interface MessageEmbedding {
  messageId: string;
  chatId: string;
  content: string;
  embedding: number[];
  classification?: string;
  createdEvent: boolean;
  eventId?: string;
  timestamp: number;
}

export interface SemanticSearchResult {
  id: string;
  text: string;
  similarity: number;
  classification?: string;
  category?: string;
}

// Storage paths
const PATTERNS_FILE = path.join(config.faissIndexPath, 'semantic_patterns.json');
const MESSAGE_EMBEDDINGS_FILE = path.join(config.faissIndexPath, 'message_embeddings.json');

// In-memory stores
let semanticPatterns: SemanticPattern[] = [];
let messageEmbeddings: MessageEmbedding[] = [];
let initialized = false;

// Pre-defined seed patterns for bootstrapping
const SEED_PATTERNS: Array<{ text: string; category: SemanticPattern['category']; classification: SemanticPattern['classification'] }> = [
  // Meeting patterns
  { text: 'meeting tomorrow at 3pm', category: 'meeting', classification: 'new_event' },
  { text: 'lets meet next week', category: 'meeting', classification: 'new_event' },
  { text: 'call scheduled for friday', category: 'meeting', classification: 'new_event' },
  { text: 'sync up at 10am', category: 'meeting', classification: 'new_event' },
  { text: 'video call tomorrow morning', category: 'meeting', classification: 'new_event' },
  
  // Reminder patterns
  { text: 'remind me to call mom', category: 'reminder', classification: 'new_event' },
  { text: 'dont forget to buy milk', category: 'reminder', classification: 'new_event' },
  { text: 'remember to pick up kids', category: 'reminder', classification: 'new_event' },
  { text: 'yaad rakhna kal subah', category: 'reminder', classification: 'new_event' },
  { text: 'note down this task', category: 'reminder', classification: 'new_event' },
  
  // Deadline patterns
  { text: 'deadline is february 8', category: 'deadline', classification: 'new_event' },
  { text: 'project due next week', category: 'deadline', classification: 'new_event' },
  { text: 'assignment submission by monday', category: 'deadline', classification: 'new_event' },
  { text: 'exam on 25th december', category: 'deadline', classification: 'new_event' },
  { text: 'last date for registration', category: 'deadline', classification: 'new_event' },
  
  // Event patterns
  { text: 'birthday party on saturday', category: 'event', classification: 'new_event' },
  { text: 'dinner at 8pm', category: 'event', classification: 'new_event' },
  { text: 'wedding function next month', category: 'event', classification: 'new_event' },
  { text: 'doctor appointment at 4', category: 'event', classification: 'new_event' },
  { text: 'flight at 6am tomorrow', category: 'event', classification: 'new_event' },
  
  // Update patterns
  { text: 'actually lets make it 5pm instead', category: 'update', classification: 'update_event' },
  { text: 'postponed to next week', category: 'update', classification: 'update_event' },
  { text: 'moved to 3pm', category: 'update', classification: 'update_event' },
  { text: 'change of plans now at 7', category: 'update', classification: 'update_event' },
  { text: 'rescheduled to monday', category: 'update', classification: 'update_event' },
  
  // Cancel patterns
  { text: 'meeting cancelled', category: 'cancel', classification: 'update_event' },
  { text: 'sorry cant make it', category: 'cancel', classification: 'update_event' },
  { text: 'lets skip today', category: 'cancel', classification: 'update_event' },
  { text: 'event called off', category: 'cancel', classification: 'update_event' },
  { text: 'not happening anymore', category: 'cancel', classification: 'update_event' },
  
  // Hinglish patterns
  { text: 'kal 3 baje milte hai', category: 'meeting', classification: 'new_event' },
  { text: 'parso deadline hai', category: 'deadline', classification: 'new_event' },
  { text: 'aaj shaam ko dinner', category: 'event', classification: 'new_event' },
  { text: 'meeting cancel ho gayi', category: 'cancel', classification: 'update_event' },
  { text: 'time change ho gaya 5pm', category: 'update', classification: 'update_event' },
];

/**
 * Initialize the semantic search module
 */
export async function initSemanticSearch(): Promise<void> {
  if (initialized) return;
  
  // Initialize vector store
  initVectorStore();
  
  // Ensure directory exists
  const vectorDir = path.dirname(PATTERNS_FILE);
  if (!fs.existsSync(vectorDir)) {
    fs.mkdirSync(vectorDir, { recursive: true });
  }
  
  // Load existing patterns
  if (fs.existsSync(PATTERNS_FILE)) {
    try {
      const data = fs.readFileSync(PATTERNS_FILE, 'utf-8');
      semanticPatterns = JSON.parse(data);
      logger.info('Loaded semantic patterns', { count: semanticPatterns.length });
    } catch (error) {
      logger.error('Failed to load semantic patterns', { error });
      semanticPatterns = [];
    }
  }
  
  // Load existing message embeddings
  if (fs.existsSync(MESSAGE_EMBEDDINGS_FILE)) {
    try {
      const data = fs.readFileSync(MESSAGE_EMBEDDINGS_FILE, 'utf-8');
      messageEmbeddings = JSON.parse(data);
      logger.info('Loaded message embeddings', { count: messageEmbeddings.length });
    } catch (error) {
      logger.error('Failed to load message embeddings', { error });
      messageEmbeddings = [];
    }
  }
  
  // Bootstrap with seed patterns if empty
  if (semanticPatterns.length === 0) {
    logger.info('Bootstrapping semantic patterns with seed data');
    await bootstrapSeedPatterns();
  }
  
  initialized = true;
  logger.info('Semantic search initialized', {
    patterns: semanticPatterns.length,
    messageEmbeddings: messageEmbeddings.length,
  });
}

/**
 * Bootstrap seed patterns with embeddings
 */
async function bootstrapSeedPatterns(): Promise<void> {
  for (const seed of SEED_PATTERNS) {
    try {
      const embedding = await generateEmbedding(seed.text);
      const pattern: SemanticPattern = {
        id: `seed_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        text: seed.text,
        embedding,
        category: seed.category,
        classification: seed.classification,
        confidence: 0.9, // High confidence for seed patterns
        hitCount: 0,
        lastUsed: new Date().toISOString(),
      };
      semanticPatterns.push(pattern);
    } catch (error) {
      logger.error('Failed to create seed pattern embedding', { text: seed.text, error });
    }
  }
  
  savePatterns();
  logger.info('Seed patterns bootstrapped', { count: semanticPatterns.length });
}

/**
 * Save patterns to file
 */
function savePatterns(): void {
  try {
    fs.writeFileSync(PATTERNS_FILE, JSON.stringify(semanticPatterns, null, 2));
  } catch (error) {
    logger.error('Failed to save semantic patterns', { error });
  }
}

/**
 * Save message embeddings to file
 */
function saveMessageEmbeddings(): void {
  try {
    // Keep only last 1000 embeddings to manage memory
    if (messageEmbeddings.length > 1000) {
      messageEmbeddings = messageEmbeddings.slice(-1000);
    }
    fs.writeFileSync(MESSAGE_EMBEDDINGS_FILE, JSON.stringify(messageEmbeddings, null, 2));
  } catch (error) {
    logger.error('Failed to save message embeddings', { error });
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;
  
  return dotProduct / magnitude;
}

/**
 * Find similar patterns to a given text
 * Used for heuristic gate boosting
 */
export async function findSimilarPatterns(
  text: string,
  topK: number = 5,
  minSimilarity: number = 0.6
): Promise<SemanticSearchResult[]> {
  if (!initialized) {
    await initSemanticSearch();
  }
  
  if (semanticPatterns.length === 0) {
    return [];
  }
  
  try {
    const queryEmbedding = await generateEmbedding(text);
    
    const results = semanticPatterns
      .map(pattern => ({
        id: pattern.id,
        text: pattern.text,
        similarity: cosineSimilarity(queryEmbedding, pattern.embedding),
        classification: pattern.classification,
        category: pattern.category,
      }))
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
    
    // Update hit counts for matched patterns
    for (const result of results) {
      const pattern = semanticPatterns.find(p => p.id === result.id);
      if (pattern) {
        pattern.hitCount++;
        pattern.lastUsed = new Date().toISOString();
      }
    }
    
    if (results.length > 0) {
      savePatterns();
    }
    
    logger.debug('Found similar patterns', {
      query: text.slice(0, 50),
      resultCount: results.length,
      topSimilarity: results[0]?.similarity,
    });
    
    return results;
  } catch (error) {
    logger.error('Failed to find similar patterns', { error });
    return [];
  }
}

/**
 * Find similar past messages for few-shot learning
 * Used by classifier for better accuracy
 */
export async function findSimilarMessages(
  text: string,
  topK: number = 3,
  minSimilarity: number = 0.65,
  onlyWithEvents: boolean = true
): Promise<Array<MessageEmbedding & { similarity: number }>> {
  if (!initialized) {
    await initSemanticSearch();
  }
  
  if (messageEmbeddings.length === 0) {
    return [];
  }
  
  try {
    const queryEmbedding = await generateEmbedding(text);
    
    let candidates = messageEmbeddings;
    if (onlyWithEvents) {
      candidates = messageEmbeddings.filter(m => m.createdEvent);
    }
    
    const results = candidates
      .map(msg => ({
        ...msg,
        similarity: cosineSimilarity(queryEmbedding, msg.embedding),
      }))
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
    
    logger.debug('Found similar messages', {
      query: text.slice(0, 50),
      resultCount: results.length,
      topSimilarity: results[0]?.similarity,
    });
    
    return results;
  } catch (error) {
    logger.error('Failed to find similar messages', { error });
    return [];
  }
}

/**
 * Store a message embedding for future similarity searches
 * Called after successful classification/extraction
 */
export async function storeMessageEmbedding(
  messageId: string,
  chatId: string,
  content: string,
  classification: string,
  createdEvent: boolean,
  eventId?: string
): Promise<void> {
  if (!initialized) {
    await initSemanticSearch();
  }
  
  // Check if already stored
  if (messageEmbeddings.some(m => m.messageId === messageId)) {
    return;
  }
  
  try {
    const embedding = await generateEmbedding(content);
    
    const messageEmbed: MessageEmbedding = {
      messageId,
      chatId,
      content,
      embedding,
      classification,
      createdEvent,
      eventId,
      timestamp: Date.now(),
    };
    
    messageEmbeddings.push(messageEmbed);
    saveMessageEmbeddings();
    
    logger.debug('Stored message embedding', {
      messageId,
      classification,
      createdEvent,
    });
  } catch (error) {
    logger.error('Failed to store message embedding', { messageId, error });
  }
}

/**
 * Add a new pattern from successful extraction
 * This is how the system learns from successful event extractions
 */
export async function learnPattern(
  text: string,
  category: SemanticPattern['category'],
  classification: SemanticPattern['classification'],
  initialConfidence: number = 0.7
): Promise<void> {
  if (!initialized) {
    await initSemanticSearch();
  }
  
  // Check if similar pattern already exists
  const similar = await findSimilarPatterns(text, 1, 0.9);
  if (similar.length > 0) {
    // Boost confidence of existing similar pattern
    const existingPattern = semanticPatterns.find(p => p.id === similar[0].id);
    if (existingPattern) {
      existingPattern.confidence = Math.min(1, existingPattern.confidence + 0.05);
      existingPattern.hitCount++;
      existingPattern.lastUsed = new Date().toISOString();
      savePatterns();
      logger.debug('Boosted existing pattern confidence', { 
        patternId: existingPattern.id,
        confidence: existingPattern.confidence,
      });
    }
    return;
  }
  
  try {
    const embedding = await generateEmbedding(text);
    
    const pattern: SemanticPattern = {
      id: `learned_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      text,
      embedding,
      category,
      classification,
      confidence: initialConfidence,
      hitCount: 1,
      lastUsed: new Date().toISOString(),
    };
    
    semanticPatterns.push(pattern);
    savePatterns();
    
    logger.info('Learned new pattern', {
      patternId: pattern.id,
      category,
      classification,
      text: text.slice(0, 50),
    });
  } catch (error) {
    logger.error('Failed to learn pattern', { text, error });
  }
}

/**
 * Get semantic boost score for heuristic gate
 * Returns a score between 0-3 based on similarity to known event patterns
 */
export async function getSemanticBoost(text: string): Promise<{
  boost: number;
  matchedCategory?: string;
  matchedClassification?: string;
  topSimilarity: number;
}> {
  if (!initialized) {
    await initSemanticSearch();
  }
  
  const similar = await findSimilarPatterns(text, 3, 0.5);
  
  if (similar.length === 0) {
    return { boost: 0, topSimilarity: 0 };
  }
  
  const top = similar[0];
  
  // Calculate boost based on similarity
  // 0.5-0.6 similarity = 0.5 boost
  // 0.6-0.7 similarity = 1 boost
  // 0.7-0.8 similarity = 2 boost
  // 0.8+ similarity = 3 boost
  let boost = 0;
  if (top.similarity >= 0.8) {
    boost = 3;
  } else if (top.similarity >= 0.7) {
    boost = 2;
  } else if (top.similarity >= 0.6) {
    boost = 1;
  } else if (top.similarity >= 0.5) {
    boost = 0.5;
  }
  
  logger.debug('Semantic boost calculated', {
    text: text.slice(0, 50),
    boost,
    topSimilarity: top.similarity,
    matchedCategory: top.category,
  });
  
  return {
    boost,
    matchedCategory: top.category,
    matchedClassification: top.classification,
    topSimilarity: top.similarity,
  };
}

/**
 * Get few-shot examples for classifier
 * Returns similar past messages with their classifications
 */
export async function getFewShotExamples(
  text: string,
  count: number = 3
): Promise<Array<{ message: string; classification: string; similarity: number }>> {
  const similar = await findSimilarMessages(text, count, 0.5, false);
  
  return similar.map(m => ({
    message: m.content,
    classification: m.classification || 'unknown',
    similarity: m.similarity,
  }));
}

/**
 * Get statistics about semantic search
 */
export function getSemanticStats(): {
  patternCount: number;
  messageEmbeddingCount: number;
  topPatterns: Array<{ text: string; hitCount: number; category: string }>;
} {
  const topPatterns = [...semanticPatterns]
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, 10)
    .map(p => ({
      text: p.text,
      hitCount: p.hitCount,
      category: p.category,
    }));
  
  return {
    patternCount: semanticPatterns.length,
    messageEmbeddingCount: messageEmbeddings.length,
    topPatterns,
  };
}

/**
 * Cleanup old/unused patterns
 */
export function cleanupPatterns(maxAge: number = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = new Date(Date.now() - maxAge).toISOString();
  const originalCount = semanticPatterns.length;
  
  // Keep seed patterns and patterns with hits, remove old unused patterns
  semanticPatterns = semanticPatterns.filter(p => 
    p.id.startsWith('seed_') || 
    p.hitCount > 0 || 
    p.lastUsed > cutoff
  );
  
  const removed = originalCount - semanticPatterns.length;
  if (removed > 0) {
    savePatterns();
    logger.info('Cleaned up old patterns', { removed });
  }
  
  return removed;
}

export default {
  initSemanticSearch,
  findSimilarPatterns,
  findSimilarMessages,
  storeMessageEmbedding,
  learnPattern,
  getSemanticBoost,
  getFewShotExamples,
  getSemanticStats,
  cleanupPatterns,
};
