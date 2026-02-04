/**
 * FAISS Vector Store Module
 * 
 * Local file-backed vector store for similarity search using faiss-node.
 */

import fs from 'fs';
import path from 'path';
import faiss from 'faiss-node';
import { VectorStore, VectorSearchResult } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Constants
const DIMENSIONS = 1536; // OpenAI text-embedding-3-small
const INDEX_FILENAME = 'faiss.index';
const MAPPING_FILENAME = 'faiss_map.json';

// State
let index: faiss.IndexFlatIP | null = null;
let ids: string[] = []; // Maps FAISS internal ID (index) to our string ID (eventId/messageId)
let initialized = false;

/**
 * Initializes the vector store
 */
export function initVectorStore(): void {
  if (initialized) return;

  const faissDir = config.faissIndexPath || path.join(process.cwd(), 'data', 'faiss');
  const indexPath = path.join(faissDir, INDEX_FILENAME);
  const mappingPath = path.join(faissDir, MAPPING_FILENAME);

  // Ensure directory exists
  if (!fs.existsSync(faissDir)) {
    fs.mkdirSync(faissDir, { recursive: true });
  }

  // Load Mapping
  if (fs.existsSync(mappingPath)) {
    try {
      const data = fs.readFileSync(mappingPath, 'utf-8');
      ids = JSON.parse(data);
    } catch (error) {
      logger.error('Failed to load FAISS mapping', { error });
      ids = [];
    }
  }

  // Load or Create Index
  if (fs.existsSync(indexPath)) {
    try {
      index = faiss.IndexFlatIP.read(indexPath);
      
       // Basic validation
       if (index && index.getDimension() !== DIMENSIONS) {
        logger.warn('Dimension mismatch in loaded index, recreating', {
          expected: DIMENSIONS,
          actual: index.getDimension()
        });
        index = new faiss.IndexFlatIP(DIMENSIONS);
        ids = []; // Reset mapping if index is recreated
      } else if (index) {
        logger.info('Loaded FAISS index', { ntotal: index.ntotal(), expected: ids.length });
      }
    } catch (error) {
      logger.error('Failed to load FAISS index, creating new one', { error });
      index = new faiss.IndexFlatIP(DIMENSIONS);
      ids = [];
    }
  } else {
    logger.info('Creating new FAISS index', { dimensions: DIMENSIONS });
    index = new faiss.IndexFlatIP(DIMENSIONS);
  }

  initialized = true;
}

/**
 * Saves the index and mapping to disk
 */
function saveIndex(): void {
  if (!index || !initialized) return;

  const faissDir = config.faissIndexPath || path.join(process.cwd(), 'data', 'faiss');
  const indexPath = path.join(faissDir, INDEX_FILENAME);
  const mappingPath = path.join(faissDir, MAPPING_FILENAME);

  try {
    index.write(indexPath);
    fs.writeFileSync(mappingPath, JSON.stringify(ids), 'utf-8');
    // logger.debug('Saved FAISS index and mapping');
  } catch (error) {
    logger.error('Failed to save FAISS index', { error });
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
      if (!index) throw new Error('Vector store not initialized');

      if (embedding.length !== DIMENSIONS) {
        throw new Error(`Invalid embedding dimension. Expected ${DIMENSIONS}, got ${embedding.length}`);
      }

      // Normalize embedding for cosine similarity
      const normalized = normalizeEmbedding(embedding);
      index.add(normalized);
      
      // Update mapping
      ids.push(eventId);
      
      // Persist
      saveIndex();
      
      logger.debug('Vector added', { eventId, total: index.ntotal() });
    },

    async search(embedding: number[], k: number): Promise<VectorSearchResult[]> {
      if (!index || index.ntotal() === 0) {
        return [];
      }

      if (embedding.length !== DIMENSIONS) {
        logger.warn('Search embedding dimension mismatch', { 
          expected: DIMENSIONS, 
          actual: embedding.length 
        });
        return [];
      }

      // FAISS search
      // search method returns { distances, labels }
      // labels are the indices in our 'ids' array
      try {
        const query = normalizeEmbedding(embedding);
        const results = index.search(query, k);
        const { labels, distances } = results;

        const searchResults: VectorSearchResult[] = [];

        // labels and distances are FlatArrays (Float32Array/Int32Array usually)
        for (let i = 0; i < labels.length; i++) {
          const idx = labels[i];
          const score = distances[i];

          // FAISS returns -1 for not found/padding
          if (idx < 0 || idx >= ids.length) continue;

          // IndexFlatIP returns inner product scores.
          // OpenAI embeddings are normalized, so inner product ~= cosine similarity.
          searchResults.push({
            eventId: ids[idx],
            similarity: score,
          });
        }

        return searchResults;
      } catch (error) {
        logger.error('FAISS search failed', { error });
        return [];
      }
    },

    async remove(eventId: string): Promise<void> {
      // FAISS IndexFlatIP doesn't support easy removal.
      // We would need to rebuild the index.
      // For MVP, we can just "soft delete" by keeping a blacklist or just ignoring it.
      // Or we can rebuild.
      if (!index) return;

      // Check if exists
      const idx = ids.indexOf(eventId);
      if (idx === -1) return;

      // Rebuild approach (naive, but robust for small datasets < 100k)
      // Since we can't easily remove from FlatIP without reconstructing.
      // WARNING: We don't have the original vectors stored separately in this file!
      // We rely on FAISS to hold them.
      // To support remove, we'd need to reconstruct() from FAISS if supported, or store vectors in DB.
      // The architecture says: "FAISS = Indices", "SQLite = Content".
      // If we need to remove from FAISS, we might need to re-index everything from SQLite.
      // For now: Log limitation.
      logger.warn('Remove not fully implemented for FAISS (requires rebuild)', { eventId });
    },
  };
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
  const embedding = new Array(DIMENSIONS).fill(0);
  
  // Normalize text
  const normalized = text.toLowerCase();
  
  // Simple character-based hashing
  for (let i = 0; i < normalized.length; i++) {
    const charCode = normalized.charCodeAt(i);
    const index = (charCode * (i + 1)) % DIMENSIONS;
    embedding[index] += 0.01;
  }
  
  // Normalize
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  
  if (norm > 0) {
    for (let i = 0; i < DIMENSIONS; i++) embedding[i] /= norm;
  }
  
  return embedding;
}

function normalizeEmbedding(embedding: number[]): number[] {
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i] * embedding[i];
  }
  if (norm === 0) return embedding;
  const scale = 1 / Math.sqrt(norm);
  const normalized = new Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) {
    normalized[i] = embedding[i] * scale;
  }
  return normalized;
}

export default { initVectorStore, getVectorStore, generateEmbedding };
