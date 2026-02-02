/**
 * FAISS Vector Store Module
 * 
 * Local file-backed vector store for similarity search.
 */

import fs from 'fs';
import path from 'path';
import { VectorStore, VectorSearchResult } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// In-memory vector storage (FAISS replacement for development)
// TODO: Replace with actual faiss-node when available
interface VectorEntry {
  eventId: string;
  embedding: number[];
}

let vectors: VectorEntry[] = [];
let initialized = false;

const VECTOR_FILE = path.join(config.faissIndexPath, 'vectors.json');

/**
 * Initializes the vector store
 */
export function initVectorStore(): void {
  if (initialized) return;

  // Ensure directory exists
  const vectorDir = path.dirname(VECTOR_FILE);
  if (!fs.existsSync(vectorDir)) {
    fs.mkdirSync(vectorDir, { recursive: true });
  }

  // Load existing vectors
  if (fs.existsSync(VECTOR_FILE)) {
    try {
      const data = fs.readFileSync(VECTOR_FILE, 'utf-8');
      vectors = JSON.parse(data);
      logger.info('Loaded vectors from file', { count: vectors.length });
    } catch (error) {
      logger.error('Failed to load vectors', { error });
      vectors = [];
    }
  }

  initialized = true;
  logger.info('Vector store initialized');
}

/**
 * Saves vectors to file
 */
function saveVectors(): void {
  try {
    fs.writeFileSync(VECTOR_FILE, JSON.stringify(vectors), 'utf-8');
  } catch (error) {
    logger.error('Failed to save vectors', { error });
  }
}

/**
 * Gets the vector store instance
 */
export function getVectorStore(): VectorStore {
  if (!initialized) {
    initVectorStore();
  }

  return {
    async addVector(eventId: string, embedding: number[]): Promise<void> {
      // Remove existing vector for this event
      vectors = vectors.filter(v => v.eventId !== eventId);
      
      // Add new vector
      vectors.push({ eventId, embedding });
      
      // Save to file
      saveVectors();
      
      logger.debug('Vector added', { eventId, dimensions: embedding.length });
    },

    async search(embedding: number[], k: number): Promise<VectorSearchResult[]> {
      if (vectors.length === 0) {
        return [];
      }

      // Calculate cosine similarity with all vectors
      const results = vectors.map(v => ({
        eventId: v.eventId,
        similarity: cosineSimilarity(embedding, v.embedding),
      }));

      // Sort by similarity (descending) and take top k
      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, k);
    },

    async remove(eventId: string): Promise<void> {
      vectors = vectors.filter(v => v.eventId !== eventId);
      saveVectors();
      logger.debug('Vector removed', { eventId });
    },
  };
}

/**
 * Calculates cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

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
 * Generates an embedding for text
 * Uses OpenAI embeddings API or fallback
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  // If OpenAI API is configured, use it
  if (config.openaiApiKey) {
    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: config.openaiApiKey });
      
      const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8000), // Limit input length
      });
      
      return response.data[0].embedding;
    } catch (error) {
      logger.error('OpenAI embedding failed, using fallback', { error });
    }
  }

  // Fallback: Simple hash-based embedding (for development)
  return generateFallbackEmbedding(text);
}

/**
 * Generates a simple fallback embedding based on text characteristics
 * This is NOT suitable for production - use OpenAI embeddings instead
 */
function generateFallbackEmbedding(text: string): number[] {
  const dimensions = 256;
  const embedding = new Array(dimensions).fill(0);
  
  // Normalize text
  const normalized = text.toLowerCase();
  
  // Simple character-based hashing
  for (let i = 0; i < normalized.length; i++) {
    const charCode = normalized.charCodeAt(i);
    const index = (charCode * (i + 1)) % dimensions;
    embedding[index] += 1;
  }
  
  // Add word-based features
  const words = normalized.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const hash = simpleHash(word);
    const index = hash % dimensions;
    embedding[index] += 2;
  }
  
  // Normalize the embedding
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= magnitude;
    }
  }
  
  return embedding;
}

/**
 * Simple string hash function
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

export default { initVectorStore, getVectorStore, generateEmbedding };
