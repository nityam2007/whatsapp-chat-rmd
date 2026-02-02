/**
 * Database Integration Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { StoredMessage, StoredEvent } from '../../src/shared/types.js';

describe('Database Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    
    // Run migrations
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        processed INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT,
        start_time TEXT,
        end_time TEXT,
        condition_type TEXT,
        condition_value TEXT,
        status TEXT NOT NULL DEFAULT 'soft',
        confidence REAL NOT NULL DEFAULT 0,
        source_message_id TEXT,
        chat_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('Messages Table', () => {
    it('should insert and retrieve message', () => {
      const message: StoredMessage = {
        id: 'msg1',
        chat_id: 'chat1',
        sender: 'User1',
        content: 'Hello world',
        timestamp: Date.now(),
        processed: false,
        created_at: new Date().toISOString(),
      };

      const insertStmt = db.prepare(`
        INSERT INTO messages (id, chat_id, sender, content, timestamp, processed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      insertStmt.run(
        message.id,
        message.chat_id,
        message.sender,
        message.content,
        message.timestamp,
        message.processed ? 1 : 0,
        message.created_at
      );

      const selectStmt = db.prepare('SELECT * FROM messages WHERE id = ?');
      const result = selectStmt.get(message.id) as Record<string, unknown>;

      expect(result.id).toBe(message.id);
      expect(result.content).toBe(message.content);
    });

    it('should get recent messages by chat', () => {
      const messages = [
        { id: 'msg1', chat_id: 'chat1', content: 'First', timestamp: 1000 },
        { id: 'msg2', chat_id: 'chat1', content: 'Second', timestamp: 2000 },
        { id: 'msg3', chat_id: 'chat2', content: 'Other chat', timestamp: 3000 },
      ];

      const insertStmt = db.prepare(`
        INSERT INTO messages (id, chat_id, sender, content, timestamp)
        VALUES (?, ?, 'User', ?, ?)
      `);

      for (const msg of messages) {
        insertStmt.run(msg.id, msg.chat_id, msg.content, msg.timestamp);
      }

      const selectStmt = db.prepare(`
        SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
      `);
      const results = selectStmt.all('chat1', 10) as Record<string, unknown>[];

      expect(results.length).toBe(2);
      expect(results[0].content).toBe('Second');
    });
  });

  describe('Events Table', () => {
    it('should insert and retrieve event', () => {
      const event = {
        id: 'evt1',
        title: 'Meeting',
        start_time: '2024-12-20T14:00:00.000Z',
        end_time: '2024-12-20T15:00:00.000Z',
        status: 'active',
        confidence: 0.9,
        source_message_id: 'msg1',
        chat_id: 'chat1',
        user_id: 'user1',
      };

      const insertStmt = db.prepare(`
        INSERT INTO events (id, title, start_time, end_time, status, confidence, source_message_id, chat_id, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        event.id,
        event.title,
        event.start_time,
        event.end_time,
        event.status,
        event.confidence,
        event.source_message_id,
        event.chat_id,
        event.user_id
      );

      const selectStmt = db.prepare('SELECT * FROM events WHERE id = ?');
      const result = selectStmt.get(event.id) as Record<string, unknown>;

      expect(result.id).toBe(event.id);
      expect(result.title).toBe(event.title);
      expect(result.status).toBe('active');
    });

    it('should update event', () => {
      const insertStmt = db.prepare(`
        INSERT INTO events (id, title, status, confidence, chat_id, user_id)
        VALUES ('evt1', 'Original', 'pending', 0.5, 'chat1', 'user1')
      `);
      insertStmt.run();

      const updateStmt = db.prepare(`
        UPDATE events SET title = ?, status = ?, updated_at = ? WHERE id = ?
      `);
      updateStmt.run('Updated', 'active', new Date().toISOString(), 'evt1');

      const selectStmt = db.prepare('SELECT * FROM events WHERE id = ?');
      const result = selectStmt.get('evt1') as Record<string, unknown>;

      expect(result.title).toBe('Updated');
      expect(result.status).toBe('active');
    });

    it('should find conflicts', () => {
      const events = [
        { id: 'evt1', start_time: '2024-12-20T14:00:00Z', end_time: '2024-12-20T15:00:00Z' },
        { id: 'evt2', start_time: '2024-12-20T14:30:00Z', end_time: '2024-12-20T15:30:00Z' },
        { id: 'evt3', start_time: '2024-12-20T16:00:00Z', end_time: '2024-12-20T17:00:00Z' },
      ];

      const insertStmt = db.prepare(`
        INSERT INTO events (id, title, start_time, end_time, status, confidence, chat_id, user_id)
        VALUES (?, 'Event', ?, ?, 'active', 0.9, 'chat1', 'user1')
      `);

      for (const evt of events) {
        insertStmt.run(evt.id, evt.start_time, evt.end_time);
      }

      // Check for conflicts with evt1's time range
      const conflictStmt = db.prepare(`
        SELECT * FROM events 
        WHERE status = 'active'
        AND id != ?
        AND start_time < ?
        AND end_time > ?
      `);
      
      const conflicts = conflictStmt.all(
        'evt1',
        '2024-12-20T15:00:00Z', // evt1 end time
        '2024-12-20T14:00:00Z'  // evt1 start time
      ) as Record<string, unknown>[];

      expect(conflicts.length).toBe(1);
      expect(conflicts[0].id).toBe('evt2');
    });

    it('should get pending events', () => {
      const insertStmt = db.prepare(`
        INSERT INTO events (id, title, status, confidence, chat_id, user_id)
        VALUES (?, ?, ?, 0.9, 'chat1', 'user1')
      `);

      insertStmt.run('evt1', 'Active Event', 'active');
      insertStmt.run('evt2', 'Pending Event', 'pending');
      insertStmt.run('evt3', 'Another Pending', 'pending');

      const selectStmt = db.prepare("SELECT * FROM events WHERE status = 'pending'");
      const results = selectStmt.all() as Record<string, unknown>[];

      expect(results.length).toBe(2);
    });
  });
});
