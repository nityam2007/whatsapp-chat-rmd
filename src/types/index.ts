/**
 * Re-export all types from shared types
 * This maintains backward compatibility
 */

export * from '../shared/types.js';

// Backward compatibility aliases
export type Database = import('../shared/types.js').IDatabase;
export type VectorStore = import('../shared/types.js').IVectorStore;
