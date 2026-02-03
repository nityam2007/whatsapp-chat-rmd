# How Argus Works - Technical Documentation

This document explains the complete flow of how Argus processes WhatsApp messages and extracts events/reminders.

---

## Table of Contents
1. [Overview](#overview)
2. [Message Flow](#message-flow)
3. [Pipeline Stages](#pipeline-stages)
4. [Event Type Detection](#event-type-detection)
5. [Update Detection (Implicit Updates)](#update-detection-implicit-updates)
6. [Time Extraction & IST Handling](#time-extraction--ist-handling)
7. [Context Building](#context-building)
8. [Deduplication with FAISS](#deduplication-with-faiss)
9. [Examples](#examples)

---

## Overview

Argus is an AI-powered event extraction system that:
1. Receives WhatsApp messages via Evolution API webhook
2. Processes them through a multi-stage pipeline
3. Extracts structured events using rule-based + LLM extraction
4. Stores events in SQLite with vector embeddings in FAISS
5. Schedules reminders and sends push notifications

### Tech Stack
- **Runtime**: Node.js with TypeScript
- **LLM**: Gemini 3 Flash Preview (via OpenAI-compatible API)
- **Vector Store**: FAISS for semantic similarity search
- **Embeddings**: Gemini text-embedding-004
- **Database**: SQLite with better-sqlite3
- **Notifications**: Web Push API

---

## Message Flow

```
WhatsApp → Evolution API → Webhook → Argus Pipeline → Event Storage
                                          ↓
                              Rule Engine (fast) ─→ If high confidence → Store
                                          ↓
                              LLM Extractor (Gemini) → Store
```

### Step-by-Step Flow

1. **Webhook Receives Message** (`src/webhook/evolution.ts`)
   - Evolution API sends webhook payload
   - Extract: chat_id, sender, content, timestamp, is_from_me
   - Phone number used as fallback if sender name unavailable

2. **Message Storage** (`src/database/sqlite.ts`)
   - Message stored in `messages` table
   - Marked as `processed: false`

3. **Pipeline Processing** (`src/pipeline/index.ts`)
   - Builds context from last 10 messages in chat
   - Runs heuristic pre-filter (skip emojis, short greetings)
   - Tries rule engine first, then LLM if needed

4. **Event Routing** (`src/pipeline/eventRouter.ts`)
   - Routes based on event_type: new_event, update_event, signal_event
   - Deduplicates using FAISS similarity search
   - Stores event and schedules reminders

---

## Pipeline Stages

### Stage 1: Heuristic Pre-filter
```typescript
// Skip messages that are clearly not events
- Single emoji or emoji-only messages
- Very short messages (< 5 chars)
- Greetings: "hi", "hello", "ok", etc.
- Media messages without text
```

### Stage 2: Context Building
```typescript
// Fetch last 10 messages from same chat
const context = await buildContext(message, 10);

// Format for LLM:
// === CHAT CONTEXT ===
// Chat with: Akshat
// Participants: Me, Akshat
// 
// === MESSAGE HISTORY ===
// [2026-02-03T10:00:00Z] Akshat: meeting tomorrow at 10 am
// [2026-02-03T10:01:00Z] Me: ok
//
// === CURRENT MESSAGE ===
// Sender: Me
// Content: now today at 10 PM
```

### Stage 3: Rule Engine (Fast Path)
```typescript
// Tries to extract without LLM using regex patterns
// Example patterns:
- "meeting at 3pm" → time: 15:00
- "tomorrow" → date: next day
- "bring milk" → task type event

// If confidence >= 0.7, skip LLM
```

### Stage 4: LLM Extraction
```typescript
// Gemini 3 Flash extracts structured data
{
  "event_type": "update_event",  // or new_event, signal_event, irrelevant
  "title": "Meeting with Tomorrow",
  "start_time": "2026-02-03T16:30:00.000Z",  // 10 PM IST
  "confidence": 0.85
}
```

### Stage 5: Event Routing
```typescript
// Routes to appropriate handler based on event_type
switch (event_type) {
  case 'new_event': handleNewEvent();    // Create with deduplication
  case 'update_event': handleUpdateEvent();  // Find & update existing
  case 'signal_event': handleSignalEvent();  // Trigger pending event
  case 'irrelevant': return null;
}
```

---

## Event Type Detection

The LLM classifies messages into 4 types:

### 1. new_event
A completely NEW event being scheduled for the first time.
```
"Let's have a meeting tomorrow at 10am"
"Bring milk on the way home"
"Doctor appointment on Friday at 3pm"
```

### 2. update_event
Modifying an EXISTING event (time, date, cancel, complete).
```
"Can we move the meeting to 3pm?"
"It got postponed to 11 AM"
"Cancel the meeting"
"now today at 10 PM"  ← implicit update (see below)
```

### 3. signal_event
A trigger for a pending/conditional event.
```
Event: "Remind me to call John when I get home"
Signal: "I'm home now" → triggers the reminder
```

### 4. irrelevant
Casual chat with no scheduling info.
```
"lol that's funny"
"ok"
"😂😂"
```

---

## Update Detection (Implicit Updates)

### The Problem
Sometimes users update events without using explicit keywords:
```
Message 1: "meeting tomorrow at 10 am"
Message 2: "now today at 10 PM"  ← User means the SAME meeting
```

The LLM might classify message 2 as `new_event` because:
- No explicit "reschedule", "postpone", "move to" keywords
- Looks like a standalone time statement

### The Solution: Implicit Update Detection

Argus uses a two-layer approach:

#### Layer 1: Enhanced LLM Prompt
```
CRITICAL RULE FOR UPDATES:
When deciding between new_event and update_event, check MESSAGE HISTORY:
- If there's a recent event in the same conversation (last 5-6 messages)
- AND current message mentions a time change WITHOUT creating a "new" event
- Then classify as update_event, NOT new_event
```

#### Layer 2: Post-LLM Heuristic Check
```typescript
// Even if LLM says "new_event", check if it should be an update
async function detectImplicitUpdate(extracted, sourceMessage) {
  // 1. Is message short? (<50 chars)
  const isShortMessage = content.length < 50;
  
  // 2. Does title look like just a time expression?
  const timeOnlyTitlePatterns = [
    /^now\s+(today|tomorrow)/i,   // "now today at..."
    /^(today|tomorrow)\s+at/i,    // "today at 10pm"
    /^at\s+\d/i,                  // "at 3pm"
  ];
  
  // 3. Is there a recent event in this chat?
  const recentEvents = getRecentEventsByChat(chatId, 5);
  const hasRecentEvent = recentEvents.length > 0;
  
  // 4. Was event created in last 30 minutes?
  const hasVeryRecentEvent = ...;
  
  // If title looks like time AND there's a recent event → UPDATE
  if (titleLooksLikeTime && hasVeryRecentEvent) {
    return true;  // Treat as update_event
  }
}
```

### Update Matching Strategy

When an update is detected, Argus finds the target event:

```typescript
// Priority 1: Same chat, title match
for (const event of recentChatEvents) {
  if (titlesOverlap(event.title, extracted.title)) {
    return event;  // Found by title
  }
}

// Priority 2: Most recent event in same chat
if (recentChatEvents.length > 0) {
  return recentChatEvents[0];
}

// Priority 3: FAISS similarity (prefers same chat)
const similar = await vectorStore.search(embedding, 5);
for (const result of similar) {
  if (result.chatId === sourceMessage.chatId) {
    return result.event;
  }
}
```

---

## Time Extraction & IST Handling

### The Rule: All User Times are IST
Users in India say "10 AM" meaning **10 AM IST** (India Standard Time, UTC+5:30).

### Conversion Flow
```
User Input: "meeting at 10 AM"
     ↓
Interpreted as: 10:00 AM IST
     ↓
Stored as UTC: 2026-02-04T04:30:00.000Z
     ↓
Displayed as: "4 Feb 2026, 10:00 AM IST"
```

### Implementation
```typescript
// src/pipeline/ruleEngine.ts
function combineDateTime(date, time) {
  // Create date in local timezone (IST on this server)
  const localDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.hours,
    time.minutes,
    0, 0
  );
  
  // toISOString() automatically converts IST → UTC
  return localDate.toISOString();
}
```

### LLM Prompt for Times
```
TIMEZONE: All times mentioned are in IST (UTC+5:30).
When outputting times, convert to UTC ISO-8601 format.

Example: "8 PM today" on Feb 3, 2026 IST
- User means 8 PM IST = 20:00 IST
- Convert: 20:00 IST - 5:30 = 14:30 UTC
- Output: "2026-02-03T14:30:00.000Z"
```

---

## Context Building

### Why Context Matters
The LLM needs context to understand:
- Who is talking to whom
- What events were discussed recently
- Whether a message is an update or new event

### Chat Isolation
**CRITICAL**: Each chat is completely isolated. Messages from different chats are NEVER mixed.
- `chat_id` uniquely identifies each conversation (e.g., `919664833459@s.whatsapp.net`)
- When looking for recent events to update, we ONLY check events from the SAME chat
- Same message sent to different chats creates SEPARATE events

### Context Window
```typescript
const CONTEXT_WINDOW_SIZE = 10;  // Last 10 messages from same chat
```

### Message Direction
Each message tracks:
- `is_from_me`: true if sent by user, false if received
- `sender`: Display name (contact name or phone number)
- `chat_id`: Which conversation this message belongs to

### Context Format for LLM
```
=== CHAT CONTEXT ===
Chat ID: 919664833459@s.whatsapp.net
Chat with: Akshat
Participants: Me, Akshat

NOTE: This is an isolated conversation. All messages below are from THIS chat only.
Messages from other chats are NOT included.

=== MESSAGE HISTORY (Last 10 messages from this chat) ===
[3/2/2026, 10:00:00 pm] Akshat → Me: meeting tomorrow at 10 am
[3/2/2026, 10:01:00 pm] Me → Akshat: ok

=== CURRENT MESSAGE (EXTRACT EVENT FROM THIS) ===
Direction: Me → Akshat
Sender: Me (ME - the user of this system)
Time (IST): 3/2/2026, 10:30:00 pm
Content: now at 5 PM
```

### Sender Identification
- Messages from `is_from_me=true` → labeled as "Me"
- Messages from contacts → use pushName or phone number as fallback
- Never show "Unknown" - always use phone number if name unavailable
- Direction shows "Me → Contact" or "Contact → Me"

---

## Deduplication with FAISS

### Problem: Duplicate Events
```
"meeting with John at 3pm"
"meeting with John at 3pm"  ← Same message sent twice
```

### Solution: Vector Similarity
1. Generate embedding for `title + message content`
2. Search FAISS for similar existing events
3. If similarity > 0.85 AND times are similar → skip duplicate

```typescript
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

// Generate embedding
const embedding = await generateEmbedding(`${title} ${content}`);

// Search for similar
const results = await vectorStore.search(embedding, 3);

if (results[0].similarity >= 0.85) {
  // Check if times are also similar (within 1 hour)
  if (isSimilarTime(extracted.start_time, existing.start_time)) {
    return existing;  // Skip duplicate
  }
}
```

---

## Examples

### Example 1: New Event Flow
```
Input: "meeting tomorrow at 10 am"
Chat: 919664833459@s.whatsapp.net
Sender: Akshat

Pipeline:
1. Heuristic: PASS (has time keyword)
2. Context: No recent events
3. Rule Engine: confidence=0.7, date=tomorrow, time=10:00
4. LLM: event_type=new_event, title="Meeting with Tomorrow"
5. Router: handleNewEvent()
6. Store: id=abc123, start_time=2026-02-04T04:30:00.000Z (10 AM IST)
7. FAISS: Store embedding for future deduplication
8. Schedule: Reminder 15 mins before

Output Event:
{
  id: "abc123",
  title: "Meeting with Tomorrow",
  start_time: "2026-02-04T04:30:00.000Z",
  status: "active",
  chat_id: "919664833459@s.whatsapp.net"
}
```

### Example 2: Implicit Update Flow
```
Input: "now today at 10 PM"
Chat: 919664833459@s.whatsapp.net (same chat as above)
Sender: Me

Pipeline:
1. Heuristic: PASS
2. Context: Shows previous "meeting tomorrow at 10 am"
3. Rule Engine: confidence=0.6 (no clear event)
4. LLM: event_type=new_event (incorrectly!)
5. Implicit Update Detection:
   - isShortMessage: true (17 chars)
   - titleLooksLikeTime: true ("Now today at 10 pm")
   - hasVeryRecentEvent: true (abc123 created 5 mins ago)
   → Override to update_event
6. Router: handleUpdateEvent()
7. Find Target: abc123 (most recent in same chat)
8. Update: start_time → 2026-02-03T16:30:00.000Z (10 PM IST)

Output:
- Event abc123 updated
- New time: 10 PM IST today
- Notification: "Event Updated: Meeting with Tomorrow to 10 PM"
```

### Example 3: Explicit Update Flow
```
Input: "it got postponed to 11 AM now"
Chat: 919664833459@s.whatsapp.net

Pipeline:
1. LLM detects "postponed" keyword → event_type=update_event
2. Router: handleUpdateEvent()
3. Find Target: Check same-chat events first
4. Match: abc123 (recent meeting in same chat)
5. Update: start_time → 11 AM IST

Output:
- Event abc123 updated to 11 AM IST
- Notification sent
```

### Example 4: Cancel Flow
```
Input: "cancel the meeting"

Pipeline:
1. LLM: event_type=update_event
2. Router detects "cancel" keyword
3. Find Target: Most recent event in chat
4. Update: status → "cancelled"

Output:
- Event marked as cancelled
- Notification: "Event Cancelled: Meeting with Tomorrow"
```

---

## Configuration

### Environment Variables
```bash
# LLM Configuration
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_API_URL=https://generativelanguage.googleapis.com/v1beta/openai

# Database
DATABASE_PATH=data/db/events.db

# Server
PORT=3000
```

### Key Constants
```typescript
CONTEXT_WINDOW_SIZE = 10;           // Messages in context
DUPLICATE_SIMILARITY_THRESHOLD = 0.85;  // FAISS dedup threshold
```

---

## File Reference

| File | Purpose |
|------|---------|
| `src/webhook/evolution.ts` | WhatsApp webhook handler |
| `src/pipeline/index.ts` | Main pipeline orchestration |
| `src/pipeline/contextBuilder.ts` | Build context from recent messages |
| `src/pipeline/ruleEngine.ts` | Fast regex-based extraction |
| `src/pipeline/extractor.ts` | LLM-based extraction |
| `src/pipeline/classifier.ts` | Event type classification |
| `src/pipeline/eventRouter.ts` | Route & store events |
| `src/database/sqlite.ts` | SQLite database operations |
| `src/vector/faiss.ts` | FAISS vector store |
| `src/scheduler/index.ts` | Reminder scheduling |
| `src/notifications/index.ts` | Push notification sending |
| `src/utils/loudLogger.ts` | Loud visual logging (v0.7.8) |

---

## Logging & Debugging (v0.7.8)

### LLM Call Logging

All LLM API calls are logged to:
1. **Console** - Visible in terminal
2. **Files** - `data/logs/llm.log` and `data/logs/llm-full.log`
3. **Database** - `llm_calls` table

### Log File Locations

| File | Contents |
|------|----------|
| `data/logs/pipeline.log` | All pipeline events |
| `data/logs/llm.log` | LLM calls summary |
| `data/logs/llm-full.log` | Full prompts and responses |
| `data/logs/errors.log` | All errors |
| `data/logs/warnings.log` | All warnings |
| `data/logs/message-flow.log` | Message tracking |

### Quick Debug Commands

```bash
# Check recent errors
cat data/logs/errors.log | tail -20

# Check LLM calls in DB
sqlite3 data/db/events.db "SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT 5;"

# Watch pipeline in real-time
tail -f data/logs/pipeline.log

# Run E2E test
npm run e2e-quick 1
```

### The llm_calls Table

```sql
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  call_type TEXT NOT NULL,  -- 'classification' | 'extraction'
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT,
  response_parsed TEXT,
  finish_reason TEXT,
  tokens_prompt INTEGER,
  tokens_completion INTEGER,
  tokens_total INTEGER,
  duration_ms INTEGER,
  success INTEGER,
  error TEXT,
  created_at TEXT
);
```

---

## Troubleshooting

### Event Created Instead of Updated
**Symptom**: "now today at 10 PM" creates new event instead of updating

**Check**:
1. Are messages being stored in the same chat_id?
2. Is there a recent event in the database for that chat?
3. Check logs for "Implicit update detection" or "detectImplicitUpdate"

**Solution**: The implicit update detection should catch this. If not, check if the message matches time-only patterns.

### Wrong Time (IST Issue)
**Symptom**: "10 AM" stored as 4:30 AM IST

**Cause**: Double conversion of IST offset

**Solution**: Fixed in v0.7.4 - the `combineDateTime()` function now correctly handles IST.

### Unknown Sender
**Symptom**: Events show "Unknown" as sender

**Solution**: Fixed in v0.7.2 - phone number is used as fallback when pushName unavailable.

---

*Last updated: v0.7.8 - Feb 3, 2026*
