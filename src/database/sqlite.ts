/**
 * SQLite Database Module
 * 
 * File-based SQL database for storing messages, events, and contacts.
 * Uses IST (Asia/Kolkata) timezone for all timestamps.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { StoredMessage, StoredEvent, Database as IDatabase } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Get current time in IST as ISO string with offset
 */
export function getISTTimestamp(): string {
  return new Date().toLocaleString('sv-SE', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).replace(' ', 'T') + '+05:30';
}

/**
 * Format date for display in IST (human readable)
 */
export function formatISTDate(date: Date | string | number): string {
  const d = new Date(date);
  return d.toLocaleString('en-IN', { 
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Format date for storage in IST (ISO-like format)
 */
export function formatISTForStorage(date: Date | string | number): string {
  const d = new Date(date);
  return d.toLocaleString('sv-SE', { 
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(' ', 'T') + '+05:30';
}

// Contact type
export interface StoredContact {
  id: string;           // WhatsApp JID (e.g., 919664833459@s.whatsapp.net)
  phone: string;        // Phone number
  name: string;         // Display name (pushName from WhatsApp)
  profile_pic?: string; // Profile picture URL
  is_group: boolean;    // Is this a group chat
  last_seen?: string;   // Last message time
  message_count: number;// Total messages from this contact
  created_at: string;
  updated_at: string;
}

let dbInstance: Database.Database | null = null;

/**
 * Initializes the SQLite database
 */
export function initDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  // Ensure directory exists
  const dbDir = path.dirname(config.databasePath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  logger.info('Initializing database', { path: config.databasePath });

  dbInstance = new Database(config.databasePath);
  dbInstance.pragma('journal_mode = WAL');

  // Run migrations
  runMigrations(dbInstance);

  return dbInstance;
}

/**
 * Runs database migrations
 */
function runMigrations(db: Database.Database): void {
  logger.info('Running database migrations');

  // Create contacts table (for tracking names and relationships)
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      phone TEXT,
      name TEXT NOT NULL,
      profile_pic TEXT,
      is_group INTEGER DEFAULT 0,
      last_seen TEXT,
      message_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_contacts_is_group ON contacts(is_group);
  `);

  // Create messages table - stores ALL messages for data collection
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      timestamp_ist TEXT,
      is_from_me INTEGER DEFAULT 0,
      message_type TEXT DEFAULT 'text',
      processed INTEGER DEFAULT 0,
      heuristic_passed INTEGER DEFAULT NULL,
      heuristic_score INTEGER DEFAULT NULL,
      heuristic_signals TEXT DEFAULT NULL,
      classification_type TEXT DEFAULT NULL,
      classification_confidence REAL DEFAULT NULL,
      extraction_success INTEGER DEFAULT NULL,
      extraction_event_id TEXT DEFAULT NULL,
      pipeline_completed INTEGER DEFAULT 0,
      pipeline_error TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES contacts(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed);
    CREATE INDEX IF NOT EXISTS idx_messages_heuristic_passed ON messages(heuristic_passed);
    CREATE INDEX IF NOT EXISTS idx_messages_pipeline_completed ON messages(pipeline_completed);
  `);

  // Create events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT,
      start_time TEXT,
      start_time_ist TEXT,
      end_time TEXT,
      end_time_ist TEXT,
      condition_type TEXT,
      condition_value TEXT,
      status TEXT NOT NULL DEFAULT 'soft',
      confidence REAL NOT NULL DEFAULT 0,
      source_message_id TEXT,
      chat_id TEXT NOT NULL,
      contact_name TEXT,
      raw_extraction TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT DEFAULT NULL,
      FOREIGN KEY (source_message_id) REFERENCES messages(id),
      FOREIGN KEY (chat_id) REFERENCES contacts(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_start_time ON events(start_time);
    CREATE INDEX IF NOT EXISTS idx_events_chat_id ON events(chat_id);
    CREATE INDEX IF NOT EXISTS idx_events_contact_name ON events(contact_name);
    CREATE INDEX IF NOT EXISTS idx_events_source_message_id ON events(source_message_id);
    CREATE INDEX IF NOT EXISTS idx_events_archived_at ON events(archived_at);
  `);

  // Create reminders table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      trigger_time TEXT NOT NULL,
      trigger_time_ist TEXT,
      sent INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_reminders_trigger_time ON reminders(trigger_time);
    CREATE INDEX IF NOT EXISTS idx_reminders_sent ON reminders(sent);
  `);

  // Create pipeline_logs table - for storing all pipeline processing data
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_logs (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL,
      data TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_message_id ON pipeline_logs(message_id);
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_stage ON pipeline_logs(stage);
    CREATE INDEX IF NOT EXISTS idx_pipeline_logs_created_at ON pipeline_logs(created_at);
  `);

  // Create archive_metadata table - for tracking archived data
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_metadata (
      id TEXT PRIMARY KEY,
      archive_date TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      messages_count INTEGER DEFAULT 0,
      events_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_archive_metadata_date ON archive_metadata(archive_date);
  `);

  // Create push_subscriptions table - for Web Push notifications
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions(endpoint);
  `);

  // Migration: Add new columns if they don't exist
  // Messages table columns
  try { db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN timestamp_ist TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN is_from_me INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN message_type TEXT DEFAULT 'text'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN heuristic_passed INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN heuristic_score INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN heuristic_signals TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN classification_type TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN classification_confidence REAL`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN extraction_success INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN extraction_event_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN pipeline_completed INTEGER DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN pipeline_error TEXT`); } catch { /* exists */ }
  
  // Events table columns
  try { db.exec(`ALTER TABLE events ADD COLUMN contact_name TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE events ADD COLUMN start_time_ist TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE events ADD COLUMN end_time_ist TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE events ADD COLUMN raw_extraction TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE events ADD COLUMN archived_at TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE events ADD COLUMN participants TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE events ADD COLUMN created_by TEXT`); } catch { /* exists */ }
  
  // Reminders table columns
  try { db.exec(`ALTER TABLE reminders ADD COLUMN trigger_time_ist TEXT`); } catch { /* exists */ }

  // Initialize pattern learning tables (auto-learning system)
  initPatternLearningTablesInternal(db);

  logger.info('Database migrations completed');
}

/**
 * Initialize pattern learning tables for the auto-learning system
 */
function initPatternLearningTablesInternal(db: Database.Database): void {
  // Table for logging LLM extractions
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_extraction_logs (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      raw_message TEXT NOT NULL,
      normalized_message TEXT NOT NULL,
      event_type TEXT,
      extracted_title TEXT,
      extracted_time TEXT,
      extracted_date TEXT,
      extracted_participants TEXT,
      llm_model TEXT,
      llm_tokens_used INTEGER DEFAULT 0,
      llm_latency_ms INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      rule_engine_tried INTEGER DEFAULT 0,
      rule_engine_confidence REAL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_llm_logs_message_id ON llm_extraction_logs(message_id);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_event_type ON llm_extraction_logs(event_type);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_created_at ON llm_extraction_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_logs_confidence ON llm_extraction_logs(confidence);
  `);

  // Table for learned patterns
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id TEXT PRIMARY KEY,
      pattern_type TEXT NOT NULL,
      regex_pattern TEXT NOT NULL UNIQUE,
      capture_groups TEXT,
      examples TEXT,
      hit_count INTEGER DEFAULT 0,
      miss_count INTEGER DEFAULT 0,
      accuracy REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 50,
      created_from_logs TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_validated_at TEXT,
      last_hit_at TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_type ON learned_patterns(pattern_type);
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_active ON learned_patterns(is_active);
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_accuracy ON learned_patterns(accuracy);
    CREATE INDEX IF NOT EXISTS idx_learned_patterns_priority ON learned_patterns(priority);
  `);

  // Table for pattern learning runs
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_learning_runs (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      logs_analyzed INTEGER DEFAULT 0,
      patterns_generated INTEGER DEFAULT 0,
      patterns_validated INTEGER DEFAULT 0,
      patterns_added INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_learning_runs_status ON pattern_learning_runs(status);
  `);
}

/**
 * Gets the database instance
 */
export function getDatabase(): IDatabase {
  const db = dbInstance || initDatabase();
  
  return {
    async storeMessage(message: StoredMessage): Promise<void> {
      const timestampIST = formatISTDate(message.timestamp * 1000);
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO messages (id, chat_id, sender, sender_name, content, timestamp, timestamp_ist, processed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        message.id,
        message.chat_id,
        message.sender,
        message.sender,  // sender_name same as sender for now
        message.content,
        message.timestamp,
        timestampIST,
        message.processed ? 1 : 0,
        message.created_at
      );
      
      logger.debug('Message stored', { id: message.id, timestampIST });
    },

    async getMessage(id: string): Promise<StoredMessage | null> {
      const stmt = db.prepare('SELECT * FROM messages WHERE id = ?');
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      
      if (!row) return null;
      
      return {
        id: row.id as string,
        chat_id: row.chat_id as string,
        sender: row.sender as string,
        content: row.content as string,
        timestamp: row.timestamp as number,
        processed: Boolean(row.processed),
        created_at: row.created_at as string,
      };
    },

    async getRecentMessages(chatId: string, limit: number): Promise<StoredMessage[]> {
      const stmt = db.prepare(`
        SELECT * FROM messages 
        WHERE chat_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `);
      
      const rows = stmt.all(chatId, limit) as Record<string, unknown>[];
      
      return rows.map(row => ({
        id: row.id as string,
        chat_id: row.chat_id as string,
        sender: row.sender as string,
        content: row.content as string,
        timestamp: row.timestamp as number,
        processed: Boolean(row.processed),
        created_at: row.created_at as string,
      }));
    },

    async storeEvent(event: StoredEvent): Promise<void> {
      // Get contact name for this chat
      const contact = getContact(db, event.chat_id);
      const contactName = contact?.name || 'Unknown';
      
      // Convert times to IST
      const startTimeIST = event.start_time ? formatISTDate(event.start_time) : null;
      const endTimeIST = event.end_time ? formatISTDate(event.end_time) : null;
      
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO events 
        (id, title, start_time, start_time_ist, end_time, end_time_ist, condition_type, condition_value, 
         status, confidence, source_message_id, chat_id, contact_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      stmt.run(
        event.id,
        event.title,
        event.start_time,
        startTimeIST,
        event.end_time,
        endTimeIST,
        event.condition_type,
        event.condition_value,
        event.status,
        event.confidence,
        event.source_message_id,
        event.chat_id,
        contactName,
        event.created_at,
        event.updated_at
      );
      
      logger.debug('Event stored', { id: event.id, contactName, startTimeIST });
    },

    async getEvent(id: string): Promise<StoredEvent | null> {
      const stmt = db.prepare(`
        SELECT e.*, m.content as source_message_content
        FROM events e
        LEFT JOIN messages m ON e.source_message_id = m.id
        WHERE e.id = ?
      `);
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      
      if (!row) return null;
      
      return rowToEvent(row);
    },

    async updateEvent(id: string, updates: Partial<StoredEvent>): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      
      for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
      
      if (fields.length === 0) return;
      
      values.push(id);
      const stmt = db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`);
      stmt.run(...values);
      
      logger.debug('Event updated', { id, fields: Object.keys(updates) });
    },

    async findConflicts(startTime: string, endTime: string, excludeId?: string): Promise<StoredEvent[]> {
      let query = `
        SELECT * FROM events 
        WHERE status = 'active'
        AND start_time IS NOT NULL 
        AND end_time IS NOT NULL
        AND (
          (start_time <= ? AND end_time > ?)
          OR (start_time < ? AND end_time >= ?)
          OR (start_time >= ? AND end_time <= ?)
        )
      `;
      
      const params: unknown[] = [startTime, startTime, endTime, endTime, startTime, endTime];
      
      if (excludeId) {
        query += ' AND id != ?';
        params.push(excludeId);
      }
      
      const stmt = db.prepare(query);
      const rows = stmt.all(...params) as Record<string, unknown>[];
      
      return rows.map(rowToEvent);
    },

    async getPendingEvents(): Promise<StoredEvent[]> {
      const stmt = db.prepare("SELECT * FROM events WHERE status = 'pending'");
      const rows = stmt.all() as Record<string, unknown>[];
      
      return rows.map(rowToEvent);
    },

    async getActiveEventsByContact(contactName: string): Promise<StoredEvent[]> {
      const stmt = db.prepare(`
        SELECT * FROM events 
        WHERE contact_name = ? 
        AND status IN ('active', 'pending', 'soft')
        ORDER BY created_at DESC
        LIMIT 10
      `);
      const rows = stmt.all(contactName) as Record<string, unknown>[];
      
      return rows.map(rowToEvent);
    },
  };
}

// ============================================
// Contact Management Functions
// ============================================

/**
 * Extract phone number from WhatsApp JID
 */
function extractPhoneFromJid(jid: string): string {
  return jid.split('@')[0];
}

/**
 * Check if JID is a group
 */
function isGroupJid(jid: string): boolean {
  return jid.includes('@g.us');
}

/**
 * Get contact by ID (internal helper)
 */
function getContact(db: Database.Database, id: string): StoredContact | null {
  const stmt = db.prepare('SELECT * FROM contacts WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  
  if (!row) return null;
  
  return {
    id: row.id as string,
    phone: row.phone as string,
    name: row.name as string,
    profile_pic: row.profile_pic as string | undefined,
    is_group: Boolean(row.is_group),
    last_seen: row.last_seen as string | undefined,
    message_count: row.message_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Upsert contact (create or update)
 */
export function upsertContact(
  chatId: string, 
  name: string, 
  profilePic?: string
): StoredContact {
  const db = dbInstance || initDatabase();
  const now = getISTTimestamp();
  const isGroup = isGroupJid(chatId);
  const phone = extractPhoneFromJid(chatId);
  
  // Check if contact exists
  const existing = getContact(db, chatId);
  
  if (existing) {
    // Update existing contact
    const stmt = db.prepare(`
      UPDATE contacts 
      SET name = ?, profile_pic = COALESCE(?, profile_pic), last_seen = ?, 
          message_count = message_count + 1, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(name, profilePic, now, now, chatId);
    
    logger.debug('Contact updated', { id: chatId, name });
    return { ...existing, name, message_count: existing.message_count + 1, updated_at: now };
  } else {
    // Create new contact
    const stmt = db.prepare(`
      INSERT INTO contacts (id, phone, name, profile_pic, is_group, last_seen, message_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(chatId, phone, name, profilePic, isGroup ? 1 : 0, now, 1, now, now);
    
    logger.info('New contact created', { id: chatId, name, isGroup });
    return {
      id: chatId,
      phone,
      name,
      profile_pic: profilePic,
      is_group: isGroup,
      last_seen: now,
      message_count: 1,
      created_at: now,
      updated_at: now,
    };
  }
}

/**
 * Get contact by ID (public function)
 */
export function getContactById(id: string): StoredContact | null {
  const db = dbInstance || initDatabase();
  return getContact(db, id);
}

/**
 * Get contact name by ID (for AI context)
 */
export function getContactName(chatId: string): string {
  const contact = getContactById(chatId);
  return contact?.name || 'Unknown';
}

/**
 * Get all contacts
 */
export function getAllContacts(): StoredContact[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM contacts ORDER BY last_seen DESC');
  const rows = stmt.all() as Record<string, unknown>[];
  
  return rows.map(row => ({
    id: row.id as string,
    phone: row.phone as string,
    name: row.name as string,
    profile_pic: row.profile_pic as string | undefined,
    is_group: Boolean(row.is_group),
    last_seen: row.last_seen as string | undefined,
    message_count: row.message_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
}

/**
 * Get contacts with most messages (for AI context)
 */
export function getTopContacts(limit: number = 20): StoredContact[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM contacts WHERE is_group = 0 ORDER BY message_count DESC LIMIT ?');
  const rows = stmt.all(limit) as Record<string, unknown>[];
  
  return rows.map(row => ({
    id: row.id as string,
    phone: row.phone as string,
    name: row.name as string,
    profile_pic: row.profile_pic as string | undefined,
    is_group: Boolean(row.is_group),
    last_seen: row.last_seen as string | undefined,
    message_count: row.message_count as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }));
}

/**
 * Get events by contact name
 */
export function getEventsByContact(contactName: string): StoredEvent[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM events WHERE contact_name = ? ORDER BY created_at DESC');
  const rows = stmt.all(contactName) as Record<string, unknown>[];
  
  return rows.map(rowToEvent);
}

/**
 * Converts database row to StoredEvent
 */
function rowToEvent(row: Record<string, unknown>): StoredEvent {
  // Parse participants from JSON string
  let participants: string[] = [];
  if (row.participants && typeof row.participants === 'string') {
    try {
      participants = JSON.parse(row.participants as string);
    } catch {
      participants = [];
    }
  }
  
  return {
    id: row.id as string,
    title: row.title as string | null,
    start_time: row.start_time as string | null,
    start_time_ist: row.start_time_ist as string | null,
    end_time: row.end_time as string | null,
    end_time_ist: row.end_time_ist as string | null,
    condition_type: row.condition_type as StoredEvent['condition_type'],
    condition_value: row.condition_value as string | null,
    status: row.status as StoredEvent['status'],
    confidence: row.confidence as number,
    source_message_id: row.source_message_id as string,
    source_message_content: row.source_message_content as string | null,
    chat_id: row.chat_id as string,
    contact_name: row.contact_name as string | null,
    participants,
    created_by: row.created_by as string | null,
    user_id: (row.user_id as string) || 'default',  // Single-user mode default
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Closes the database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    logger.info('Database connection closed');
  }
}

// ============================================
// Message Management Functions
// ============================================

/**
 * Get all messages with pagination
 */
export function getMessages(options: {
  limit?: number;
  offset?: number;
  chatId?: string;
  search?: string;
}): { messages: StoredMessage[]; total: number } {
  const db = dbInstance || initDatabase();
  const { limit = 50, offset = 0, chatId, search } = options;
  
  let whereClause = '1=1';
  const params: unknown[] = [];
  
  if (chatId) {
    whereClause += ' AND chat_id = ?';
    params.push(chatId);
  }
  
  if (search) {
    whereClause += ' AND content LIKE ?';
    params.push(`%${search}%`);
  }
  
  // Get total count
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM messages WHERE ${whereClause}`);
  const { count: total } = countStmt.get(...params) as { count: number };
  
  // Get messages
  const stmt = db.prepare(`
    SELECT * FROM messages 
    WHERE ${whereClause}
    ORDER BY timestamp DESC 
    LIMIT ? OFFSET ?
  `);
  
  const rows = stmt.all(...params, limit, offset) as Record<string, unknown>[];
  
  const messages = rows.map(row => ({
    id: row.id as string,
    chat_id: row.chat_id as string,
    sender: row.sender as string,
    content: row.content as string,
    timestamp: row.timestamp as number,
    processed: Boolean(row.processed),
    created_at: row.created_at as string,
  }));
  
  return { messages, total };
}

// ============================================
// Event Management Functions (Extended)
// ============================================

/**
 * Get all events with pagination and filtering
 */
export function getEvents(options: {
  limit?: number;
  offset?: number;
  status?: string;
  contactName?: string;
  search?: string;
}): { events: StoredEvent[]; total: number } {
  const db = dbInstance || initDatabase();
  const { limit = 50, offset = 0, status, contactName, search } = options;
  
  let whereClause = '1=1';
  const params: unknown[] = [];
  
  if (status) {
    whereClause += ' AND status = ?';
    params.push(status);
  }
  
  if (contactName) {
    whereClause += ' AND contact_name = ?';
    params.push(contactName);
  }
  
  if (search) {
    whereClause += ' AND (title LIKE ? OR contact_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  // Get total count
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM events WHERE ${whereClause}`);
  const { count: total } = countStmt.get(...params) as { count: number };
  
  // Get events with source message content (JOIN with messages)
  const stmt = db.prepare(`
    SELECT e.*, m.content as source_message_content
    FROM events e
    LEFT JOIN messages m ON e.source_message_id = m.id
    WHERE ${whereClause.replace(/\b(title|contact_name|status)\b/g, 'e.$1')}
    ORDER BY e.created_at DESC 
    LIMIT ? OFFSET ?
  `);
  
  const rows = stmt.all(...params, limit, offset) as Record<string, unknown>[];
  
  return { events: rows.map(rowToEvent), total };
}

/**
 * Get event by ID
 */
export function getEventById(id: string): StoredEvent | null {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare(`
    SELECT e.*, m.content as source_message_content
    FROM events e
    LEFT JOIN messages m ON e.source_message_id = m.id
    WHERE e.id = ?
  `);
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  
  if (!row) return null;
  return rowToEvent(row);
}

/**
 * Update event status (accept/decline/snooze)
 */
export function updateEventStatus(
  id: string, 
  status: 'pending' | 'active' | 'declined' | 'completed' | 'snoozed'
): StoredEvent | null {
  const db = dbInstance || initDatabase();
  const now = getISTTimestamp();
  
  const stmt = db.prepare(`
    UPDATE events 
    SET status = ?, updated_at = ?
    WHERE id = ?
  `);
  
  stmt.run(status, now, id);
  
  logger.info('Event status updated', { id, status });
  return getEventById(id);
}

/**
 * Delete event
 */
export function deleteEvent(id: string): boolean {
  const db = dbInstance || initDatabase();
  
  const stmt = db.prepare('DELETE FROM events WHERE id = ?');
  const result = stmt.run(id);
  
  logger.info('Event deleted', { id, deleted: result.changes > 0 });
  return result.changes > 0;
}

/**
 * Get upcoming events (for dashboard)
 */
export function getUpcomingEvents(limit: number = 10): StoredEvent[] {
  const db = dbInstance || initDatabase();
  const now = new Date().toISOString();
  
  const stmt = db.prepare(`
    SELECT e.*, m.content as source_message_content
    FROM events e
    LEFT JOIN messages m ON e.source_message_id = m.id
    WHERE e.status IN ('pending', 'active') 
    AND (e.start_time >= ? OR e.start_time IS NULL)
    ORDER BY 
      CASE WHEN e.start_time IS NULL THEN 1 ELSE 0 END,
      e.start_time ASC
    LIMIT ?
  `);
  
  const rows = stmt.all(now, limit) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

/**
 * Get event statistics
 */
export function getEventStats(): {
  total: number;
  pending: number;
  active: number;
  completed: number;
  declined: number;
  todayCount: number;
} {
  const db = dbInstance || initDatabase();
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) as declined
    FROM events
  `).get() as Record<string, number>;
  
  // Get today's count
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();
  
  const todayCount = db.prepare(`
    SELECT COUNT(*) as count FROM events 
    WHERE created_at >= ?
  `).get(todayISO) as { count: number };
  
  return {
    total: stats.total || 0,
    pending: stats.pending || 0,
    active: stats.active || 0,
    completed: stats.completed || 0,
    declined: stats.declined || 0,
    todayCount: todayCount.count || 0,
  };
}

/**
 * Get message statistics
 */
export function getMessageStats(): {
  total: number;
  processed: number;
  todayCount: number;
} {
  const db = dbInstance || initDatabase();
  
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN processed = 1 THEN 1 ELSE 0 END) as processed
    FROM messages
  `).get() as Record<string, number>;
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTimestamp = Math.floor(today.getTime() / 1000);
  
  const todayCount = db.prepare(`
    SELECT COUNT(*) as count FROM messages 
    WHERE timestamp >= ?
  `).get(todayTimestamp) as { count: number };
  
  return {
    total: stats.total || 0,
    processed: stats.processed || 0,
    todayCount: todayCount.count || 0,
  };
}

// ============================================
// Message Deduplication
// ============================================

/**
 * Check if a message already exists (for deduplication)
 */
export function messageExists(id: string): boolean {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT 1 FROM messages WHERE id = ? LIMIT 1');
  const row = stmt.get(id);
  return !!row;
}

/**
 * Check if an event already exists for a given source message ID
 */
export function eventExistsForMessage(sourceMessageId: string): boolean {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT 1 FROM events WHERE source_message_id = ? LIMIT 1');
  const row = stmt.get(sourceMessageId);
  return !!row;
}

/**
 * Get existing event for a source message
 */
export function getEventBySourceMessage(sourceMessageId: string): StoredEvent | null {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM events WHERE source_message_id = ?');
  const row = stmt.get(sourceMessageId) as Record<string, unknown> | undefined;
  
  if (!row) return null;
  return rowToEvent(row);
}

// ============================================
// Enhanced Message Storage with Pipeline Data
// ============================================

export interface EnhancedMessage extends StoredMessage {
  is_from_me?: boolean;
  message_type?: string;
  heuristic_passed?: boolean | null;
  heuristic_score?: number | null;
  heuristic_signals?: string[] | null;
  classification_type?: string | null;
  classification_confidence?: number | null;
  extraction_success?: boolean | null;
  extraction_event_id?: string | null;
  pipeline_completed?: boolean;
  pipeline_error?: string | null;
}

/**
 * Store message with enhanced fields
 */
export function storeEnhancedMessage(message: EnhancedMessage): void {
  const db = dbInstance || initDatabase();
  const timestampIST = formatISTDate(message.timestamp * 1000);
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO messages 
    (id, chat_id, sender, sender_name, content, timestamp, timestamp_ist, is_from_me, 
     message_type, processed, heuristic_passed, heuristic_score, heuristic_signals,
     classification_type, classification_confidence, extraction_success, extraction_event_id,
     pipeline_completed, pipeline_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    message.id,
    message.chat_id,
    message.sender,
    message.sender,
    message.content,
    message.timestamp,
    timestampIST,
    message.is_from_me ? 1 : 0,
    message.message_type || 'text',
    message.processed ? 1 : 0,
    message.heuristic_passed === null ? null : (message.heuristic_passed ? 1 : 0),
    message.heuristic_score ?? null,
    message.heuristic_signals ? JSON.stringify(message.heuristic_signals) : null,
    message.classification_type ?? null,
    message.classification_confidence ?? null,
    message.extraction_success === null ? null : (message.extraction_success ? 1 : 0),
    message.extraction_event_id ?? null,
    message.pipeline_completed ? 1 : 0,
    message.pipeline_error ?? null,
    message.created_at
  );
  
  logger.debug('Enhanced message stored', { id: message.id, timestampIST });
}

/**
 * Update message with heuristic results
 */
export function updateMessageHeuristic(
  messageId: string, 
  passed: boolean, 
  score: number, 
  signals: string[]
): void {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare(`
    UPDATE messages 
    SET heuristic_passed = ?, heuristic_score = ?, heuristic_signals = ?
    WHERE id = ?
  `);
  stmt.run(passed ? 1 : 0, score, JSON.stringify(signals), messageId);
  logger.debug('Message heuristic updated', { messageId, passed, score });
}

/**
 * Update message with classification results
 */
export function updateMessageClassification(
  messageId: string, 
  eventType: string, 
  confidence: number
): void {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare(`
    UPDATE messages 
    SET classification_type = ?, classification_confidence = ?
    WHERE id = ?
  `);
  stmt.run(eventType, confidence, messageId);
  logger.debug('Message classification updated', { messageId, eventType, confidence });
}

/**
 * Update message with extraction results
 */
export function updateMessageExtraction(
  messageId: string, 
  success: boolean, 
  eventId?: string
): void {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare(`
    UPDATE messages 
    SET extraction_success = ?, extraction_event_id = ?, processed = 1
    WHERE id = ?
  `);
  stmt.run(success ? 1 : 0, eventId ?? null, messageId);
  logger.debug('Message extraction updated', { messageId, success, eventId });
}

/**
 * Mark message pipeline as completed
 */
export function updateMessagePipelineComplete(messageId: string, error?: string): void {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare(`
    UPDATE messages 
    SET pipeline_completed = 1, pipeline_error = ?
    WHERE id = ?
  `);
  stmt.run(error ?? null, messageId);
  logger.debug('Message pipeline completed', { messageId, hasError: !!error });
}

// ============================================
// Pipeline Logs
// ============================================

export interface PipelineLogEntry {
  id: string;
  message_id: string;
  stage: string;
  status: string;
  data?: Record<string, unknown>;
  duration_ms?: number;
  created_at?: string;
}

/**
 * Store a pipeline log entry
 */
export function storePipelineLog(entry: Omit<PipelineLogEntry, 'id' | 'created_at'>): void {
  const db = dbInstance || initDatabase();
  const id = `${entry.message_id}-${entry.stage}-${Date.now()}`;
  
  const stmt = db.prepare(`
    INSERT INTO pipeline_logs (id, message_id, stage, status, data, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    id,
    entry.message_id,
    entry.stage,
    entry.status,
    entry.data ? JSON.stringify(entry.data) : null,
    entry.duration_ms ?? null,
    getISTTimestamp()
  );
}

/**
 * Get pipeline logs for a message
 */
export function getPipelineLogs(messageId: string): PipelineLogEntry[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM pipeline_logs WHERE message_id = ? ORDER BY created_at ASC');
  const rows = stmt.all(messageId) as Record<string, unknown>[];
  
  return rows.map(row => ({
    id: row.id as string,
    message_id: row.message_id as string,
    stage: row.stage as string,
    status: row.status as string,
    data: row.data ? JSON.parse(row.data as string) : undefined,
    duration_ms: row.duration_ms as number | undefined,
    created_at: row.created_at as string,
  }));
}

// ============================================
// Data Archival System
// ============================================

/**
 * Archive old data (HOT data = 3 months, then archive)
 */
export function archiveOldData(archiveBasePath: string = './data/archive'): {
  messagesArchived: number;
  eventsArchived: number;
  archivePath: string;
} {
  const db = dbInstance || initDatabase();
  const fs = require('fs');
  const path = require('path');
  
  // Calculate 3 months ago
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const cutoffTimestamp = Math.floor(threeMonthsAgo.getTime() / 1000);
  const cutoffISO = threeMonthsAgo.toISOString();
  
  // Create archive directory structure: yyyy/mm/dd
  const now = new Date();
  const archivePath = path.join(
    archiveBasePath,
    now.getFullYear().toString(),
    (now.getMonth() + 1).toString().padStart(2, '0'),
    now.getDate().toString().padStart(2, '0')
  );
  
  if (!fs.existsSync(archivePath)) {
    fs.mkdirSync(archivePath, { recursive: true });
  }
  
  // Get messages to archive
  const messagesStmt = db.prepare(`
    SELECT * FROM messages 
    WHERE timestamp < ? AND pipeline_completed = 1
  `);
  const messagesToArchive = messagesStmt.all(cutoffTimestamp) as Record<string, unknown>[];
  
  // Get events to archive (that are completed/cancelled or have old start times)
  const eventsStmt = db.prepare(`
    SELECT * FROM events 
    WHERE (status IN ('completed', 'cancelled') AND created_at < ?)
       OR (start_time IS NOT NULL AND start_time < ?)
  `);
  const eventsToArchive = eventsStmt.all(cutoffISO, cutoffISO) as Record<string, unknown>[];
  
  if (messagesToArchive.length === 0 && eventsToArchive.length === 0) {
    logger.info('No data to archive');
    return { messagesArchived: 0, eventsArchived: 0, archivePath };
  }
  
  // Write archive files
  const archiveTimestamp = now.toISOString().replace(/[:.]/g, '-');
  
  if (messagesToArchive.length > 0) {
    const messagesFile = path.join(archivePath, `messages-${archiveTimestamp}.json`);
    fs.writeFileSync(messagesFile, JSON.stringify(messagesToArchive, null, 2));
    logger.info('Messages archived', { count: messagesToArchive.length, file: messagesFile });
  }
  
  if (eventsToArchive.length > 0) {
    const eventsFile = path.join(archivePath, `events-${archiveTimestamp}.json`);
    fs.writeFileSync(eventsFile, JSON.stringify(eventsToArchive, null, 2));
    logger.info('Events archived', { count: eventsToArchive.length, file: eventsFile });
  }
  
  // Mark events as archived (don't delete, just mark)
  const archiveAt = getISTTimestamp();
  for (const event of eventsToArchive) {
    db.prepare('UPDATE events SET archived_at = ? WHERE id = ?').run(archiveAt, event.id);
  }
  
  // Store archive metadata
  const metaId = `archive-${archiveTimestamp}`;
  db.prepare(`
    INSERT INTO archive_metadata (id, archive_date, archive_path, messages_count, events_count)
    VALUES (?, ?, ?, ?, ?)
  `).run(metaId, archiveAt, archivePath, messagesToArchive.length, eventsToArchive.length);
  
  logger.info('Archive completed', {
    messagesArchived: messagesToArchive.length,
    eventsArchived: eventsToArchive.length,
    archivePath,
  });
  
  return {
    messagesArchived: messagesToArchive.length,
    eventsArchived: eventsToArchive.length,
    archivePath,
  };
}

/**
 * Get archive metadata
 */
export function getArchiveMetadata(): { id: string; archive_date: string; archive_path: string; messages_count: number; events_count: number }[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM archive_metadata ORDER BY created_at DESC');
  return stmt.all() as { id: string; archive_date: string; archive_path: string; messages_count: number; events_count: number }[];
}

// ============================================
// Reminder Functions
// ============================================

/**
 * Store a reminder in the database
 */
export function storeReminder(reminder: {
  id: string;
  event_id: string;
  trigger_time: string;
  sent?: boolean;
}): void {
  const db = dbInstance || initDatabase();
  const triggerTimeIST = formatISTDate(reminder.trigger_time);
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO reminders (id, event_id, trigger_time, trigger_time_ist, sent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    reminder.id,
    reminder.event_id,
    reminder.trigger_time,
    triggerTimeIST,
    reminder.sent ? 1 : 0,
    new Date().toISOString()
  );
  
  logger.debug('Reminder stored', { id: reminder.id, eventId: reminder.event_id, triggerTimeIST });
}

/**
 * Mark a reminder as sent
 */
export function markReminderSent(reminderId: string): void {
  const db = dbInstance || initDatabase();
  db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminderId);
  logger.debug('Reminder marked as sent', { reminderId });
}

/**
 * Get pending reminders (not sent, trigger time in future)
 */
export function getPendingReminders(): { id: string; event_id: string; trigger_time: string; trigger_time_ist: string }[] {
  const db = dbInstance || initDatabase();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    SELECT id, event_id, trigger_time, trigger_time_ist 
    FROM reminders 
    WHERE sent = 0 AND trigger_time > ?
    ORDER BY trigger_time ASC
  `);
  return stmt.all(now) as { id: string; event_id: string; trigger_time: string; trigger_time_ist: string }[];
}

/**
 * Delete a reminder
 */
export function deleteReminder(reminderId: string): void {
  const db = dbInstance || initDatabase();
  db.prepare('DELETE FROM reminders WHERE id = ?').run(reminderId);
  logger.debug('Reminder deleted', { reminderId });
}

/**
 * Get reminders for an event
 */
export function getRemindersForEvent(eventId: string): { id: string; trigger_time: string; trigger_time_ist: string; sent: boolean }[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT id, trigger_time, trigger_time_ist, sent FROM reminders WHERE event_id = ?');
  const rows = stmt.all(eventId) as { id: string; trigger_time: string; trigger_time_ist: string; sent: number }[];
  return rows.map(r => ({ ...r, sent: r.sent === 1 }));
}

// ============================================
// Enhanced Store Event with Raw Extraction
// ============================================

/**
 * Store event with raw extraction data
 */
export function storeEventWithExtraction(event: StoredEvent, rawExtraction?: Record<string, unknown>): void {
  const db = dbInstance || initDatabase();
  
  const contact = getContact(db, event.chat_id);
  const contactName = event.contact_name || contact?.name || 'Unknown';
  
  const startTimeIST = event.start_time ? formatISTDate(event.start_time) : null;
  const endTimeIST = event.end_time ? formatISTDate(event.end_time) : null;
  
  // Serialize participants array to JSON
  const participantsJson = event.participants && event.participants.length > 0 
    ? JSON.stringify(event.participants) 
    : null;
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO events 
    (id, title, start_time, start_time_ist, end_time, end_time_ist, condition_type, condition_value, 
     status, confidence, source_message_id, chat_id, contact_name, participants, created_by, raw_extraction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    event.id,
    event.title,
    event.start_time,
    startTimeIST,
    event.end_time,
    endTimeIST,
    event.condition_type,
    event.condition_value,
    event.status,
    event.confidence,
    event.source_message_id,
    event.chat_id,
    contactName,
    participantsJson,
    event.created_by || null,
    rawExtraction ? JSON.stringify(rawExtraction) : null,
    event.created_at,
    event.updated_at
  );
  
  logger.debug('Event stored with extraction', { 
    id: event.id, 
    contactName, 
    startTimeIST,
    participants: event.participants,
    createdBy: event.created_by,
  });
}

// ============================================
// Push Subscription Functions
// ============================================

export interface PushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent?: string;
  created_at: string;
  last_used?: string;
}

/**
 * Store a push subscription
 */
export function storePushSubscription(subscription: {
  user_id?: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}): PushSubscription {
  const db = dbInstance || initDatabase();
  const id = `push_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const now = getISTTimestamp();
  const userId = subscription.user_id || 'default';
  
  // Delete existing subscription with same endpoint (upsert behavior)
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subscription.endpoint);
  
  const stmt = db.prepare(`
    INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    id,
    userId,
    subscription.endpoint,
    subscription.keys.p256dh,
    subscription.keys.auth,
    subscription.userAgent || null,
    now
  );
  
  logger.info('Push subscription stored', { 
    id, 
    userId, 
    endpoint: subscription.endpoint.slice(0, 50) + '...' 
  });
  
  return {
    id,
    user_id: userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_agent: subscription.userAgent,
    created_at: now,
  };
}

/**
 * Get all push subscriptions for a user
 */
export function getPushSubscriptions(userId: string = 'default'): PushSubscription[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
  const rows = stmt.all(userId) as Record<string, unknown>[];
  
  return rows.map(row => ({
    id: row.id as string,
    user_id: row.user_id as string,
    endpoint: row.endpoint as string,
    p256dh: row.p256dh as string,
    auth: row.auth as string,
    user_agent: row.user_agent as string | undefined,
    created_at: row.created_at as string,
    last_used: row.last_used as string | undefined,
  }));
}

/**
 * Get all push subscriptions (for broadcast)
 */
export function getAllPushSubscriptions(): PushSubscription[] {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('SELECT * FROM push_subscriptions');
  const rows = stmt.all() as Record<string, unknown>[];
  
  return rows.map(row => ({
    id: row.id as string,
    user_id: row.user_id as string,
    endpoint: row.endpoint as string,
    p256dh: row.p256dh as string,
    auth: row.auth as string,
    user_agent: row.user_agent as string | undefined,
    created_at: row.created_at as string,
    last_used: row.last_used as string | undefined,
  }));
}

/**
 * Delete a push subscription
 */
export function deletePushSubscription(endpoint: string): boolean {
  const db = dbInstance || initDatabase();
  const stmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const result = stmt.run(endpoint);
  
  logger.info('Push subscription deleted', { 
    endpoint: endpoint.slice(0, 50) + '...', 
    deleted: result.changes > 0 
  });
  
  return result.changes > 0;
}

/**
 * Update last_used timestamp for a subscription
 */
export function updatePushSubscriptionLastUsed(endpoint: string): void {
  const db = dbInstance || initDatabase();
  const now = getISTTimestamp();
  
  db.prepare('UPDATE push_subscriptions SET last_used = ? WHERE endpoint = ?').run(now, endpoint);
}

export default { 
  initDatabase, 
  getDatabase, 
  closeDatabase, 
  upsertContact, 
  getContactById, 
  getContactName, 
  getAllContacts, 
  getTopContacts,
  getEventsByContact,
  getISTTimestamp,
  formatISTDate,
  formatISTForStorage,
  // Message functions
  getMessages,
  messageExists,
  storeEnhancedMessage,
  updateMessageHeuristic,
  updateMessageClassification,
  updateMessageExtraction,
  updateMessagePipelineComplete,
  // Event functions
  getEvents,
  getEventById,
  updateEventStatus,
  deleteEvent,
  getUpcomingEvents,
  getEventStats,
  getMessageStats,
  eventExistsForMessage,
  getEventBySourceMessage,
  storeEventWithExtraction,
  // Pipeline logs
  storePipelineLog,
  getPipelineLogs,
  // Archive functions
  archiveOldData,
  getArchiveMetadata,
  // Push subscription functions
  storePushSubscription,
  getPushSubscriptions,
  getAllPushSubscriptions,
  deletePushSubscription,
  updatePushSubscriptionLastUsed,
};
