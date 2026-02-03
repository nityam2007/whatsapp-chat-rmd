# Changelog

All notable changes to this project will be documented in this file.
New entries are added at the TOP of this file (append-only, newest first).

---

## [0.8.1] - 2026-02-03

### Fixed - Proactive Triggers & Push Notification Sync

Major fixes to make the proactive trigger system work end-to-end.

#### 1. Push Notification Subscription Sync

**Problem**: Webapp stored push subscriptions in a JSON file, but the main RMD server read from SQLite. They were disconnected, causing push notifications to never be sent.

**Solution**: 
- Added push subscription API endpoints to main server (`src/server.ts`):
  - `GET /api/push/vapid-key` - Get VAPID public key
  - `POST /api/push/subscribe` - Register push subscription
  - `POST /api/push/unsubscribe` - Remove subscription
  - `POST /api/push/test` - Send test notification
  - `GET /api/push/status` - Check push configuration
- Updated webapp to forward subscriptions to main RMD server on subscribe/unsubscribe
- Added auto-sync on webapp startup (3 second delay for RMD server readiness)
- Added manual sync endpoint `/api/sync-subscriptions`
- Added "Sync Now" button in webapp Push Notifications page
- Added RMD push status display showing subscription count from main server

#### 2. Proactive Trigger Keyword Matching

**Problem**: "just reached goa" wasn't triggering the "Get cashew from goa" event because FAISS fallback embeddings don't work well for semantic similarity.

**Solution**: Added keyword-based matching as a fallback layer:
- New `keywordContextMatch()` function in `proactiveTrigger.ts`
- Extracts significant words from messages and events
- Matches location keywords (e.g., "goa" in both messages)
- Detects location trigger patterns ("reached", "arrived", "at", etc.)
- Confidence boost for location triggers

**New Matching Strategy (3 stages)**:
```
Stage 1: FAISS vector similarity (fast, works with OpenAI embeddings)
Stage 1.5: Keyword matching (fallback when FAISS finds nothing)
Stage 2: Gemini LLM (smart, for medium-confidence matches)
```

#### 3. Pipeline Live View in Dashboard

**New page**: Pipeline Live View in webapp dashboard
- Visual flow diagram showing all 13 pipeline stages with icons
- Live activity feed showing recent messages and their pipeline stages
- Auto-refresh toggle (2-second interval)
- Stage counts displayed on each step

#### 4. Build Error Fix

**Fixed**: Type error in `proactiveTrigger.ts` line 225
```typescript
// Changed from:
suggestedAction: event.title,
// To:
suggestedAction: event.title || undefined,
```

#### 5. Database Stats Enhancement

- Added `message_embeddings` and `semantic_patterns` tables to database stats display
- All 13 database tables now visible in the dashboard

#### 6. Token Compression Verification

- Verified token compression is working correctly in the pipeline
- Compression correctly skips for small messages (< 2000 tokens)
- Uses tiktoken for accurate token counting

#### Files Modified
```
src/server.ts                    # Added push subscription API endpoints
src/services/proactiveTrigger.ts # Added keyword matching, verbose logging
src/database/sqlite.ts           # Added message_embeddings, semantic_patterns to stats
webapp/server.ts                 # Subscription sync to RMD server, auto-sync, /api/rmd-push-status
webapp/public/index.html         # Pipeline Live page, sync UI in notifications
webapp/public/css/styles.css     # Pipeline visualization styles
webapp/public/js/app.js          # Pipeline live functions, sync function, RMD status
webapp/public/js/api.js          # Added fetchRmdPushStatus()
```

#### To Test Proactive Triggers
1. Start servers: `npm run dev` and `npm run webapp`
2. Go to webapp -> Push Notifications -> click "Sync Now"
3. Create event: send "get cashew from goa" via WhatsApp
4. Wait for event to be created
5. Send "just reached goa" via WhatsApp
6. Should receive push notification for the cashew event

---

## [0.8.0] - 2026-02-03

### Added - Proactive Trigger System

Major new feature: The system is now **proactive**, not just reactive. When you send ANY message, Argus intelligently checks if it relates to any pending tasks and reminds you automatically.

#### The Problem (Client Feedback)
> "The system is just like Notion - it only stores tasks. When I say 'reached Goa', it should remind me about 'Get cashew from Goa for Priya'."

#### The Solution: Intelligent Context Matching

Uses Gemini's 1M token context window to understand relationships between incoming messages and pending tasks. This is NOT keyword matching - it's intelligent semantic understanding.

**Examples of what it can detect:**
| Message | Triggers |
|---------|----------|
| "Just reached Goa" | "Get cashew from Goa for Priya" |
| "Meeting with John went well" | "Ask John about the project" |
| "Feeling better now" | "Schedule doctor follow-up when feeling better" |
| "The client approved the design" | "Send invoice after approval" |
| "Finally got some free time" | Any pending leisure tasks |

#### New Services Created

**1. Proactive Trigger Service** (`src/services/proactiveTrigger.ts`)
- `checkForProactiveTriggers()` - Called for EVERY incoming message
- Uses Gemini to intelligently match messages against ALL pending events
- Sends reminders via Web Push notification
- Tracks trigger counts to avoid spam

**2. Context Matcher Service** (`src/services/contextMatcher.ts`)
- `smartContextMatch()` - Gemini-based semantic matching
- `extractContextTags()` - Extracts context tags from new events
- Tags include: location, keywords, trigger contexts

**3. Cron Scheduler** (`src/scheduler/cronScheduler.ts`)
- Polls database every minute for due reminders (backup for in-memory timers)
- Sends weekly digest every Sunday at 9am IST
- Survives server restarts

#### Database Schema Updates

Added new columns to `events` table:
```sql
ALTER TABLE events ADD COLUMN context_tags TEXT;        -- JSON: ["goa", "shopping"]
ALTER TABLE events ADD COLUMN location TEXT;            -- Primary location
ALTER TABLE events ADD COLUMN trigger_keywords TEXT;    -- Keywords that trigger reminder
ALTER TABLE events ADD COLUMN proactive_triggered INTEGER DEFAULT 0;
ALTER TABLE events ADD COLUMN proactive_trigger_count INTEGER DEFAULT 0;
```

New functions:
- `getEventsForProactiveTrigger()` - Get pending events for matching
- `markEventProactivelyTriggered()` - Mark event as triggered
- `resetProactiveTrigger()` - Reset for snooze
- `updateEventContextTags()` - Update context tags

#### Pipeline Integration

The proactive check runs BEFORE normal pipeline processing:

```
Incoming Message
      │
      ▼
┌─────────────────────────────────────┐
│ 1. PROACTIVE TRIGGER CHECK          │ ← NEW! Runs for ALL messages
│    - Load pending events            │
│    - Gemini matches context         │
│    - Send reminders if matched      │
└─────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────┐
│ 2. NORMAL PIPELINE                  │
│    - Heuristic → Classification     │
│    - Extraction → Routing           │
└─────────────────────────────────────┘
```

#### Configuration Options

New environment variables:
```env
EVOLUTION_INSTANCE=default           # WhatsApp instance name
ENABLE_PROACTIVE_TRIGGERS=true       # Enable/disable proactive system
PROACTIVE_CHECK_INTERVAL=60000       # Check interval in ms
```

#### Dependencies Added
- `cron` - For persistent reminder scheduling

#### Files Modified/Created
```
src/services/proactiveTrigger.ts     # NEW: Main proactive service
src/services/contextMatcher.ts       # NEW: Gemini context matching
src/scheduler/cronScheduler.ts       # NEW: Cron-based scheduler
src/database/sqlite.ts               # Added proactive columns/functions
src/shared/types.ts                  # Added context_tags, location, trigger_keywords
src/config/index.ts                  # Added Evolution and proactive config
src/pipeline/index.ts                # Integrated proactive check
src/pipeline/extractor.ts            # Added context fields
src/pipeline/ruleEngine.ts           # Added context fields
src/pipeline/eventRouter.ts          # Added proactive fields to StoredEvent
tests/integration/pipeline.test.ts   # Fixed for new required fields
```

#### Note on WhatsApp
WhatsApp via Evolution API is **READ-ONLY**. All reminders are sent via Web Push notifications only.

---

## [0.7.9] - 2026-02-03

### Fixed - Reminder Classification & UI Event Actions

Major improvements to event classification accuracy and UI functionality.

#### 1. Reminder Classification Fixed

**Problem**: Messages like "bring potato on your way home" were incorrectly classified as `irrelevant` because they lacked explicit time references.

**Solution**: Added support for implicit time contexts and action+item reminder patterns.

**Changes to Heuristic Gate** (`heuristicGate.ts`):
- Added implicit time keywords: "on your way", "way back", "way home", "coming home", "reaching home"
- Added strong patterns for action+location combos: `/(bring|get|buy).*way.*home/`
- Added action+item detection that bypasses the time requirement
- Common items recognized: milk, potato, groceries, medicine, etc.

**Changes to Classifier** (`classifier.ts`):
- Updated prompt to recognize reminders with implicit timing
- Added examples: "Bring potatoes on your way home" → new_event
- Updated fallback classification with action+item pattern detection
- Implicit time patterns: "on your way", "way back", "when you come", etc.

#### 2. UI Event Actions Fixed

**Problem**: 
- `/api/logs/all` endpoint was being caught by `/api/logs/:step` (route ordering)
- Soft events had no action buttons
- Active events had no "Complete" button

**Solution**:
- Reordered routes: `/api/logs/all` and `/api/logs/file/:filename` now come BEFORE `/api/logs/:step`
- Added Accept/Decline buttons for `soft` status events
- Added Complete button for `active` status events

#### Test Results After Fix

| Message | Before | After |
|---------|--------|-------|
| "bring potato on your way home" | irrelevant | **new_event** ✓ |
| "get milk from store" | irrelevant | **new_event** ✓ |
| "Meeting tomorrow at 3pm" | new_event | **new_event** ✓ |
| "Postpone to 5pm instead" | update_event | **update_event** ✓ |
| "Done" | dropped | **dropped** ✓ (correct) |
| "Ok kale payment thai jase" | dropped | **dropped** ✓ (correct) |

#### Files Modified
```
src/pipeline/heuristicGate.ts  # Added implicit time patterns, action+item detection
src/pipeline/classifier.ts     # Updated prompt and fallback for reminders
src/server.ts                  # Fixed route ordering for /api/logs/*
webapp/public/js/app.js        # Added action buttons for soft/active events
```

---

## [0.7.8] - 2026-02-03

### Added - Comprehensive Logging System & E2E Testing

Major additions to improve debugging, observability, and testing of the AI pipeline.

#### 1. LLM Call Logging System

**Problem**: When LLM responses were truncated or malformed, there was no way to diagnose the issue.

**Solution**: Added comprehensive LLM input/output logging to both database and files.

**New Database Table** (`llm_calls`):
```sql
CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  call_type TEXT NOT NULL,  -- 'classification' | 'extraction' | 'other'
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

**New Functions** (`sqlite.ts`):
- `storeLLMCall(log)` - Store LLM API call details
- `getLLMCalls(limit, callType)` - Retrieve LLM calls for analysis

#### 2. Loud Logger Utility

**New File**: `src/utils/loudLogger.ts`

Visual logging system with:
- `logStep()` - Pipeline step markers with emojis
- `logLLM()` - LLM input/output logging (console + file)
- `logSuccess()` - Green checkmark success logs
- `logWarn()` - Yellow warning logs
- `logError()` - **YELLING** error logs with visual separators
- `logData()` - Data collection/debugging logs
- `logMessageFlow()` - Message tracking through pipeline

**Log Files** (in `data/logs/`):
- `pipeline.log` - All pipeline events
- `llm.log` - LLM calls summary
- `llm-full.log` - Full prompts and responses
- `errors.log` - All errors (easy to grep)
- `warnings.log` - All warnings
- `message-flow.log` - Message tracking

#### 3. E2E Test Scripts

**New Files**:
- `scripts/e2e-test.ts` - Comprehensive test with 8 scenarios
- `scripts/e2e-quick.ts` - Quick single-scenario runner

**npm Scripts**:
```json
"e2e-test": "tsx scripts/e2e-test.ts",
"e2e-quick": "tsx scripts/e2e-quick.ts"
```

**Test Scenarios**:
1. Simple event: "meeting tomorrow at 3 PM"
2. Hinglish event: "kal 5 baje meeting hai"
3. Reminder: "remind me to call John at 6pm"
4. Task: "bring milk on the way home"
5. Update: "postpone the meeting to 4 PM"
6. Cancel: "cancel the meeting"
7. Irrelevant: "lol that's funny"
8. Time-only update: "now at 10 PM" (implicit update)

### Fixed - Gemini API Truncation Bug

**Problem**: Messages like "meeting tomorrow at 3 PM" were being classified as `irrelevant` with confidence 0.3 (the parse failure indicator).

**Root Cause**: Gemini's `gemini-3-flash-preview` model has a "thinking mode" that uses internal tokens. With `max_tokens: 50`, the response was truncated (`finish_reason: "length"`), resulting in incomplete JSON like `{"event_type": "`.

**Fix**:
- `classifier.ts`: Changed `max_tokens` from 50 → 2000
- `extractor.ts`: Changed `max_tokens` from 300 → 2000

#### Files Added
```
src/utils/loudLogger.ts       # NEW - Loud logging utility
scripts/e2e-test.ts           # NEW - Full E2E test suite
scripts/e2e-quick.ts          # NEW - Quick E2E test runner
```

#### Files Modified
```
src/database/sqlite.ts        # Added llm_calls table and functions
src/pipeline/classifier.ts    # Added logging, fixed max_tokens
src/pipeline/extractor.ts     # Fixed max_tokens
package.json                  # Added e2e-test and e2e-quick scripts
docs/WORKING.md               # Updated documentation
CHANGELOG.md                  # This entry
```

#### Quick Commands
```bash
# Run quick E2E test
npm run e2e-quick 1

# Run full E2E test suite
npm run e2e-test

# Check LLM calls in DB
sqlite3 data/db/events.db "SELECT * FROM llm_calls ORDER BY created_at DESC LIMIT 5;"

# Check error logs
cat data/logs/errors.log

# Check LLM full logs
cat data/logs/llm-full.log
```

---

## [0.7.7] - 2026-02-03

### Fixed - Chat Isolation & Message Direction Tracking

Fixed issue where `is_from_me` flag wasn't being properly stored, and improved context formatting to show clear message direction (who sent to whom).

#### Issues Fixed
1. **is_from_me not stored**: Messages weren't recording whether they were sent by the user
2. **Unclear direction**: Context didn't clearly show "Me → Contact" vs "Contact → Me"
3. **Chat isolation unclear**: LLM might not understand messages are from ONE specific chat

#### Changes

**Database Storage** (`sqlite.ts`):
- Added `is_from_me` to INSERT statement in `storeMessage()`
- Added `is_from_me` to returned objects in `getMessage()` and `getRecentMessages()`

**Webhook** (`evolution.ts`):
- Added `is_from_me: isFromMe` to returned StoredMessage object

**Context Builder** (`contextBuilder.ts`):
- Added `Chat ID` to context header for clarity
- Added explicit note: "This is an isolated conversation. Messages from other chats are NOT included."
- Changed message format to show direction: `[time] Me → Akshat: content`
- Current message now shows `Direction: Me → Akshat`
- Times now shown in IST format

#### Example Context (After Fix)
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

#### Files Modified
```
src/webhook/evolution.ts      # Added is_from_me to StoredMessage
src/database/sqlite.ts        # Store and retrieve is_from_me
src/pipeline/contextBuilder.ts # Enhanced context format with direction
CHANGELOG.md                  # This entry
```

---

## [0.7.6] - 2026-02-03

### Fixed - Time-Only Messages Being Dropped

Fixed issue where short time-only messages like "now at 5 PM..." were being classified as irrelevant and dropped instead of being treated as event updates.

#### Root Cause
1. The classifier prompt didn't have examples of time-only update messages
2. Short messages like "now at 5 PM" were classified as `irrelevant` before reaching the implicit update detection

#### Fix
1. **Updated classifier prompt** (`classifier.ts`):
   - Added examples of time-only update messages
   - Added explicit note: "Short messages with just a time are likely update_event"
   
2. **Enhanced implicit update detection** (`eventRouter.ts`):
   - Added `contentLooksLikeTime` check (not just title)
   - Added more patterns: "now at 5", "changed to 5pm", "actually 5pm"
   - Added Hindi patterns: "ab 5 baje"

#### Files Modified
```
src/pipeline/classifier.ts    # Updated prompt with time-only examples
src/pipeline/eventRouter.ts   # Enhanced detectImplicitUpdate()
CHANGELOG.md                  # This entry
```

---

## [0.7.5] - 2026-02-03

### Added - Implicit Update Detection & Technical Documentation

Fixed issue where messages like "now today at 10 PM" were creating new events instead of updating recent events in the same chat.

#### The Problem
```
Message 1: "meeting tomorrow at 10 am"  → Creates event (correct)
Message 2: "now today at 10 PM"         → Creates NEW event (WRONG!)
```

The LLM classified message 2 as `new_event` because it lacks explicit update keywords like "reschedule" or "postpone".

#### The Solution: Two-Layer Implicit Update Detection

**Layer 1: Enhanced LLM Prompt** (`extractor.ts`)
- Added explicit instructions for the LLM to check MESSAGE HISTORY
- If recent event exists in same chat AND current message is time-only → classify as `update_event`

**Layer 2: Post-LLM Heuristic** (`eventRouter.ts`)
- Added `detectImplicitUpdate()` function that checks:
  1. Is message short? (<50 chars)
  2. Does extracted title look like just a time? ("now today at...", "at 3pm")
  3. Is there a very recent event in the same chat? (last 30 mins)
- If all conditions met, override `new_event` → `update_event`

#### Example Flow (After Fix)
```
"now today at 10 PM"
  ↓
LLM: event_type=new_event (still wrong)
  ↓
detectImplicitUpdate():
  - isShortMessage: true
  - titleLooksLikeTime: true ("Now today at 10 pm")
  - hasVeryRecentEvent: true (meeting created 5 mins ago)
  ↓
Override to update_event
  ↓
Find target: most recent event in same chat
  ↓
Update event time to 10 PM IST
```

#### Documentation Added
- **docs/WORKING.md** - Comprehensive technical documentation explaining:
  - Complete message flow
  - Pipeline stages
  - Event type detection logic
  - Implicit update detection
  - IST timezone handling
  - Context building
  - FAISS deduplication
  - Examples with code

#### Files Modified
```
src/pipeline/extractor.ts     # Enhanced LLM prompt for update detection
src/pipeline/eventRouter.ts   # Added detectImplicitUpdate() function
docs/WORKING.md               # NEW - Full technical documentation
README.md                     # Added context & timezone info
CHANGELOG.md                  # This entry
```

---

## [0.7.4] - 2026-02-03

### Fixed - IST Timezone Double-Conversion Bug

Fixed critical bug where times extracted by the rule engine were being converted from IST to UTC **twice**, resulting in events being scheduled 5.5 hours earlier than intended.

#### The Bug
When user says "meeting at 10 AM":
- **Before (WRONG)**: Stored as `2026-02-03T23:00:00.000Z` (4:30 AM IST next day!)
- **After (CORRECT)**: Stored as `2026-02-04T04:30:00.000Z` (10:00 AM IST)

#### Root Cause
The `combineDateTime()` function was:
1. Creating a Date with `new Date(year, month, day, 10, 0)` → Already in local IST
2. Then subtracting 5.5 hours again → Double conversion!

#### Fix
Removed the manual IST offset subtraction. The JavaScript `Date` constructor already creates dates in local timezone (IST), and `.toISOString()` automatically converts to UTC.

#### Files Modified
```
src/pipeline/ruleEngine.ts    # Fixed combineDateTime() function
CHANGELOG.md                  # This entry
```

---

## [0.7.3] - 2026-02-03

### Fixed - Event Update Logic (Same Chat Priority)

Fixed issue where update messages like "it got postponed to 11 AM now" were creating new events instead of updating existing ones in the same chat.

#### Update Strategy (New)
1. **Same Chat Priority**: First look for recent events in the SAME chat
2. **Title Matching**: Match by title similarity (words in common)
3. **Most Recent Fallback**: If no title match, use most recent event in chat
4. **FAISS Fallback**: Use vector similarity search if no same-chat events

#### Changes
- **eventRouter.ts** - Completely rewritten `handleUpdateEvent()`:
  - Added `getRecentEventsByChat()` check before FAISS
  - Title matching with word overlap detection
  - FAISS search now prioritizes same-chat matches
  - Added `RESCHEDULE_KEYWORDS` for detecting time updates
  - Sends "Event Updated" notification with old→new time
  - Detailed logging of match source and updated fields
- **sqlite.ts** - Added `getRecentEventsByChat(chatId, limit)` function

#### Example Flow
```
Message 1: "meeting tomorrow at 10 am" → Creates event (ID: abc123)
Message 2: "it got postponed to 11 AM now" → Updates event abc123 (not new!)
```

#### Reschedule Keywords Added
```
postponed, postpone, rescheduled, reschedule, moved to, changed to,
shifted to, pushed to, delayed to, now at, updated to, new time,
preponed, advanced to, badal gaya (Hindi)
```

#### Files Modified
```
src/pipeline/eventRouter.ts   # Rewritten handleUpdateEvent(), RESCHEDULE_KEYWORDS
src/database/sqlite.ts        # Added getRecentEventsByChat()
CHANGELOG.md                  # This entry
```

---

## [0.7.2] - 2026-02-03

### Fixed - Phone Number Fallback for Unknown Contacts

When Evolution API doesn't provide a contact name (pushName), the system now uses the phone number as the identifier instead of showing "Unknown".

#### Changes
- **evolution.ts** - Extract phone from JID when pushName not available
  - `getDisplayName()` helper function added
  - `extractPhoneFromJid()` converts `919664833459@s.whatsapp.net` → `+919664833459`
- **sqlite.ts** - `getContactName()` and `getContactNameInternal()` use phone fallback
- **contextBuilder.ts** - Uses `getContactName()` with phone fallback for LLM context
- Events, messages, and logs now show phone number instead of "Unknown"

#### Example
Before: `Sender: Unknown`
After: `Sender: +919664833459`

#### Files Modified
```
src/webhook/evolution.ts      # Phone extraction helpers, getDisplayName()
src/database/sqlite.ts        # getContactName(), getContactNameInternal() with phone fallback
src/pipeline/contextBuilder.ts # Uses getContactName() for contact and sender
CHANGELOG.md                  # This entry
```

---

## [0.7.1] - 2026-02-03

### Changed - Documentation Update

#### Updated Documentation
- **RULES.md** - Added critical AI assistant rules section at top
  - Mandatory workflow: update CHANGELOG, run tests, commit/push
  - Quick reference commands
  - Documentation update requirements table
  - Version info (v0.7.0, Gemini 3 Flash)
  - **NEW: Database Cleanup Guide** - Which tables to keep vs clear
- **INFO.md** - Updated to v0.7.0
  - Added Gemini 3 as primary LLM
  - Updated tech stack with Gemini models
  - Added Gemini environment variables
  - Updated version history
- **README.md** - Added Gemini configuration
  - Prerequisites now mention Gemini API key
  - New "AI Model Configuration" section
  - Available Gemini models table
  - Updated environment variables
- **docs/ARCHITECTURE.md** - Updated to v0.7.1
  - Changed all LLM references from GPT-4o to Gemini 3 Flash
  - Updated system architecture diagram (Gemini as primary extractor)
  - Updated pipeline diagrams with correct model names
  - Updated multi-container architecture (added Gemini API)
  - Added version history entries for v0.6.0, v0.7.0, v0.7.1
- **docs/diagrams/03-ai-pipeline.mmd** - Updated extractor to Gemini 3 Flash
- **docs/diagrams/05-complete-data-flow.mmd** - Updated to show dual AI services (OpenAI for classifier, Gemini for extractor)

#### Files Modified
```
RULES.md                           # Added AI assistant rules, DB cleanup guide
INFO.md                            # Updated to v0.7.0, Gemini 3
README.md                          # Added Gemini config
CHANGELOG.md                       # This entry
docs/ARCHITECTURE.md               # Updated LLM refs to Gemini 3 Flash
docs/diagrams/03-ai-pipeline.mmd   # Extractor → Gemini 3 Flash
docs/diagrams/05-complete-data-flow.mmd  # Dual AI services
```

---

## [0.7.0] - 2026-02-03

### Changed - Gemini 3 Flash Preview + Improved Dashboard

#### LLM Update
- **Upgraded to Gemini 3 Flash Preview** (`gemini-3-flash-preview`) for classification and extraction
- Gemini 3 Flash offers best speed + intelligence balance (latest model)
- Also supports `gemini-3-pro-preview` for most powerful extraction

#### Improved Webapp Dashboard
Complete redesign of the webapp with a professional, clean UI:

- **No emojis** - Clean, professional interface using SVG icons
- **Auto-refresh** - Dashboard auto-refreshes every 10 seconds with countdown indicator
- **Event management** - Full Accept/Decline/Snooze/Complete workflow for all event statuses
- **Metrics page** - New page showing pipeline performance metrics
- **Better status filtering** - Filter events by `pending_confirmation`, `snoozed`, etc.
- **Source message display** - Shows original WhatsApp message that created each event
- **Improved typography** - Better readability with proper font sizing and spacing

#### New Webapp Features
- **Snooze endpoint** - Added `/api/events/:id/snooze` proxy
- **Metrics endpoints** - Added `/api/metrics` and `/api/metrics/summary` proxies
- **Status badge colors** - Distinct colors for each event status

#### Technical Changes
- Updated version to 0.7.0 in server health endpoint
- Removed box-drawing Unicode characters from server banners (compatibility)
- All 237 tests passing

#### Files Modified
```
.env                           # Updated GEMINI_MODEL to gemini-3-flash-preview
webapp/public/index.html       # Complete redesign - professional UI, fixed metrics
webapp/server.ts               # Added snooze and metrics proxy endpoints
src/server.ts                  # Updated version and banner
RULES.md                       # Added Gemini 3 model documentation
```

---

## [0.6.0] - 2026-02-03

### Added - Pending Confirmation Feature

A new feature that allows capturing any type of reminder or task from WhatsApp messages (like "bring vegetable on your way home") and creating events that can be accepted or declined via push notification.

#### Problem Solved

Previously, messages like "bring vegetable on your way home" were detected by the heuristic gate but the rule engine would return `skipLLM: false` because there was no explicit time. This caused the pipeline to fall back to LLM extraction, and if the LLM was unavailable or failed, no event was created.

#### New Behavior

- **Tasks without explicit time** (e.g., "bring sabzi", "get milk") are now captured with `pending_confirmation` status
- **Contextual triggers** (e.g., "on your way home", "when you leave", "after work") are detected and stored as conditions
- **Push notifications** with Accept/Decline actions are sent immediately for pending confirmation events

#### New Components

- **Contextual Trigger Detection** (`src/pipeline/ruleEngine.ts`)
  - Location-based triggers: "on your way home", "on way to work", "when leaving", "when reaching", "near [location]"
  - Time-based triggers: "after work", "before work", "during lunch", "in the evening", "in the morning"
  - Event-based triggers: "after meeting", "before meeting"

- **Enhanced Rule Engine Result** (`src/pipeline/ruleEngine.ts`)
  - New fields: `isTask`, `hasContextualTrigger`, `contextualTrigger`
  - Tasks now skip LLM even without explicit time
  - Contextual triggers are extracted and stored as event conditions

- **New Event Status** (`src/shared/types.ts`)
  - Added `pending_confirmation`, `declined`, `snoozed` to `EventStatus` enum

- **Pending Confirmation Notifications** (`src/pipeline/eventRouter.ts`)
  - Events with `pending_confirmation` status trigger immediate push notifications
  - Notifications include Accept/Decline action buttons

- **Push Notification Actions** (`src/notifications/index.ts`)
  - Added `actions`, `icon`, `badge` fields to push notification payload

#### Examples

| Message | Result |
|---------|--------|
| "bring vegetable on your way home" | ✅ Event created, status: `pending_confirmation`, condition: `location:on way home` |
| "get milk when you leave office" | ✅ Event created, status: `pending_confirmation`, condition: `location:when leaving` |
| "buy coffee after work" | ✅ Event created, status: `pending_confirmation`, condition: `time:after work` |
| "bring sabzi" | ✅ Event created, status: `pending_confirmation` |
| "meeting tomorrow at 3pm" | ✅ Event created, status: `active` (has explicit time) |

#### API Endpoints

The following existing endpoints work with pending confirmation events:

- `POST /api/events/:id/accept` - Accept a pending confirmation event (changes status to `active`)
- `POST /api/events/:id/decline` - Decline a pending confirmation event (changes status to `declined`)

---

## [0.5.0] - 2025-02-02

### Added - Auto-Learning System
A major new feature that enables the system to learn from LLM extractions and automatically generate new regex patterns for the Rule Engine. This creates a feedback loop where the system gets smarter over time:

```
More LLM extractions → Pattern analysis → New rules → Less LLM usage → Cost savings
```

#### New Components

- **Pattern Learner Service** (`src/pipeline/patternLearner.ts`)
  - `logLLMExtraction()` - Logs all LLM extractions for analysis
  - `runPatternLearning()` - Analyzes logs and generates patterns
  - `getCompiledLearnedPatterns()` - Returns patterns for Rule Engine
  - Pattern validation against historical data
  - Automatic pattern deactivation for low accuracy (<50%)
  - Hit/miss tracking with accuracy calculation

- **New Database Tables**
  - `llm_extraction_logs` - Stores all LLM extractions for learning
  - `learned_patterns` - Stores auto-generated regex patterns
  - `pattern_learning_runs` - Tracks learning run history

- **Rule Engine Enhancements** (`src/pipeline/ruleEngine.ts`)
  - Dynamic pattern loading from database
  - Automatic pattern reload (every 5 minutes)
  - Pattern hit/miss tracking callbacks
  - `loadLearnedPatterns()` - Load patterns at startup
  - `needsPatternReload()` - Check if reload needed
  - `getLearnedPatternCounts()` - Get loaded pattern stats

- **Extractor Enhancements** (`src/pipeline/extractor.ts`)
  - LLM extraction logging callback
  - Token usage and latency tracking
  - Metadata support for pattern learning

- **New API Endpoints** (Auto-Learning)
  - `GET /api/learning/stats` - Pattern learning statistics
  - `GET /api/learning/patterns` - List all learned patterns
  - `GET /api/learning/logs` - View LLM extraction logs
  - `POST /api/learning/run` - Trigger manual pattern learning
  - `DELETE /api/learning/patterns/:id` - Deactivate a pattern

- **Scheduled Tasks**
  - Pattern learning runs every hour (configurable via `PATTERN_LEARNING_INTERVAL`)
  - Pattern reload check every 5 minutes
  - Graceful shutdown cleanup for all intervals

### How It Works

1. **LLM Extraction Logging**: Every time the LLM extracts an event, the raw message, extracted data, tokens used, and latency are logged.

2. **Pattern Analysis**: Periodically (default: hourly), the PatternLearner analyzes the logs looking for:
   - Common time patterns (e.g., "X baje", "around X pm")
   - Common date patterns (e.g., "agle monday", "coming friday")
   - Common action patterns (e.g., "need to X", "mujhe X karna hai")

3. **Pattern Validation**: Before adding a pattern, it's validated against historical data to ensure 70%+ precision.

4. **Rule Engine Integration**: Validated patterns are loaded into the Rule Engine and used alongside static patterns. If a learned pattern matches, it increases confidence.

5. **Accuracy Tracking**: Every pattern hit/miss is tracked. Patterns with <50% accuracy after 10+ attempts are automatically deactivated.

### Configuration

```bash
# Pattern learning interval (default: 1 hour)
PATTERN_LEARNING_INTERVAL=3600000

# Metrics logging interval (default: 5 minutes)
METRICS_LOG_INTERVAL=300000
```

### Files Added/Modified
```
src/pipeline/patternLearner.ts    # NEW - Pattern learning service
src/pipeline/ruleEngine.ts        # Dynamic pattern loading
src/pipeline/extractor.ts         # Extraction logging
src/database/sqlite.ts            # New tables for pattern learning
src/server.ts                     # Learning API endpoints, v0.5.0
src/index.ts                      # Integration, scheduled tasks
```

### Technical Notes
- Patterns require 3+ examples before being considered
- Minimum 70% precision required for validation
- Patterns auto-deactivate after 10+ attempts with <50% accuracy
- Learning runs are logged for debugging/auditing
- All 225 tests passing

---

## [0.4.1] - 2025-02-02

### Added
- **Pipeline Metrics System**
  - New `src/utils/metrics.ts` module for tracking pipeline performance
  - MetricsCollector singleton with counters for:
    - Messages processed/dropped/passed
    - Rule engine extractions vs LLM extractions
    - Events created/updated
    - Error tracking
  - Timer utility class for precise timing measurements
  - Ring buffer for last 1000 timing measurements
  - Derived rates: heuristicDropRate, ruleEngineHitRate, llmSkipRate, errorRate

- **Metrics API Endpoints**
  - `GET /api/metrics` - Full pipeline metrics object
  - `GET /api/metrics/summary` - Human-readable summary with percentages
  - `POST /api/metrics/reset` - Reset metrics (protected endpoint)

- **Periodic Metrics Logging**
  - Configurable via `METRICS_LOG_INTERVAL` env var (default: 5 minutes)
  - Logs final metrics summary on graceful shutdown
  - Set to 0 to disable periodic logging

- **Comprehensive Metrics Tests**
  - `tests/unit/metrics.test.ts` - 51 unit tests covering:
    - Counter operations for all recording methods
    - Rate calculations with edge cases
    - Timing recording with ring buffer overflow
    - Timer utility (mark, elapsed, duration, getAllTimings)
    - Real-world scenario simulations
  - `tests/integration/api.test.ts` - 5 new API endpoint tests

### Technical Details
- Metrics integrated into pipeline at all stages
- Timer class supports marks for stage-by-stage timing
- Ring buffer prevents memory growth for timing data
- All 225 tests passing

### Files Added/Modified
```
src/utils/metrics.ts          # NEW - Metrics collection module
src/server.ts                 # Added metrics API endpoints
src/index.ts                  # Added periodic metrics logging
tests/unit/metrics.test.ts    # NEW - 51 unit tests
tests/integration/api.test.ts # Added 5 metrics API tests
```

---

## [0.4.0] - 2025-02-02

### Added
- **Rule Engine Unit Tests**
  - `tests/unit/ruleEngine.test.ts` - 77 comprehensive tests
  - Time extraction (12-hour, 24-hour, o'clock, half past, quarter, relative)
  - Date extraction (today, tomorrow, weekdays, month names, slash format)
  - Hindi time words (aaj, kal, parso, baje)
  - Event type detection and confidence scoring
  - LLM skip logic validation

- **Regional Language Support in Heuristic Gate**
  - 200+ new keywords for regional languages:
    - Tamil: inru, naalai, kaalaila, manikku, pannu, marakkathe
    - Telugu: eeroju, repu, ippudu, marchipoku, gurthu
    - Marathi: udya, aaj, sakali, visaru naka, athvan kara
    - Bengali: aj, kal, porsu, sokal, bhulona, mone rekho
    - Gujarati: aaje, kale, parase, bhulta nahi, yaad rakhjo
  - Extended Hindi/Hinglish: action verbs (karna, lena, dena variations)
  - 20+ new STRONG_PATTERNS for regional languages
  - `tests/unit/heuristicGate.test.ts` expanded to 27 tests

### Changed
- Pipeline now tracks metrics at each stage
- Replaced `Date.now()` timing with `Timer` class

### Files Added
```
tests/unit/ruleEngine.test.ts  # 77 tests for rule engine
```

### Files Modified
```
src/pipeline/heuristicGate.ts       # Regional language keywords
tests/unit/heuristicGate.test.ts    # Regional language tests
src/pipeline/index.ts               # Metrics integration
```

---

## [0.3.0] - 2025-02-02

### Added
- **Startup Scripts**
  - `scripts/start.sh` - One-command startup for all services
  - `scripts/stop.sh` - Clean shutdown of all services  
  - `scripts/test-message.sh` - Quick test message sender
  - Auto-generates VAPID keys on first run
  - Creates required directories automatically

- **Self-Hosted Push Notification Webapp**
  - New `webapp/` directory with complete push notification service
  - Beautiful web UI for enabling browser notifications
  - Service worker for receiving push notifications
  - Subscription management with persistent storage
  - Test notification endpoint
  - Runs on port 3002

- **Comprehensive README**
  - Quick start guide (3 simple steps)
  - Alternative manual start instructions
  - Complete endpoint documentation
  - Evolution API integration guide
  - Troubleshooting section

### Changed
- Updated start script to use `npx tsx` for webapp (no watch mode for stability)
- Environment loading now works correctly from project root

### Files Added
```
scripts/
├── start.sh          # Main startup script
├── stop.sh           # Stop all services
└── test-message.sh   # Test message sender

webapp/
├── server.ts         # Express server for push notifications
└── public/
    ├── index.html    # Web UI
    ├── sw.js         # Service worker
    └── manifest.json # PWA manifest
```

---

## [0.2.1] - 2025-02-02

### Fixed
- **Webhook Event Handling**
  - Non-message events (e.g., `connection.update`) now return 200 with `ignored` status
  - Validation order fixed: check event type before requiring `data.key`

- **API Error Handling**
  - JSON parsing errors now return 400 (was 500)
  - Added proper SyntaxError detection from body-parser

- **Notifications Endpoint**
  - Fixed `/api/notifications` returning 500 due to missing module
  - Moved notification history storage into server module

- **Test Suite**
  - Fixed pipeline integration tests for mock persistence
  - All 79 tests now passing
  - Removed `vi.resetModules()` that was breaking mock persistence

### Technical Details
- Mock functions extracted to module level for proper persistence in tests
- Error handler now detects `entity.parse.failed` type for JSON errors

---

## [0.2.0] - 2025-02-02

### Added
- **Multi-Container Architecture**
  - Orchestrator service for central management
  - Per-user container isolation
  - Container lifecycle management (create/stop/restart)
  - Health monitoring for all containers

- **Orchestrator Features**
  - Dashboard API (`/api/dashboard/*`)
  - WebSocket support for real-time updates
  - Push notification service (Web Push)
  - Redis integration for pub/sub messaging
  - Container manager with Docker integration

- **Shared Types with Zod**
  - All types now validated with Zod schemas
  - Runtime type safety for external data
  - Shared types between containers

- **Comprehensive Test Suite**
  - Migrated to Vitest (from Jest)
  - Unit tests for all pipeline modules
  - Integration tests for API and database
  - 70% coverage target

- **Updated Dependencies (Latest Versions)**
  - Node.js 22.x support
  - Express.js 5.x
  - OpenAI SDK 6.x (gpt-4o models)
  - better-sqlite3 12.x
  - Vitest 4.x
  - TypeScript 5.9.x

### Changed
- Default LLM models updated:
  - Small: `gpt-4o-mini` (was `gpt-3.5-turbo`)
  - Big: `gpt-4o` (was `gpt-4`)
- ES Modules throughout (dropped CommonJS)
- Configuration expanded for multi-container setup
- Docker setup now includes Redis and orchestrator

### Technical Details
- Multi-container: 1 orchestrator + N user containers
- Inter-container communication via Redis pub/sub
- WebSocket for dashboard real-time updates
- Zod for runtime schema validation

---

## [0.1.0] - 2025-02-02

### Added
- Initial project setup
- Project documentation structure (INFO.md, RULES.md, CHANGELOG.md)
- TypeScript configuration with strict mode
- Express.js server with webhook endpoint
- Complete pipeline implementation:
  - Heuristic Gate for signal detection
  - Small LLM Classifier for event type classification
  - Context Builder for conversation aggregation
  - Token Compressor using quicksave library
  - Big LLM Extractor for structured data extraction
  - Event Router for handling different event types
- SQLite database with migrations
- FAISS vector store integration
- Scheduler service for reminders
- Notification service (Web Push ready)
- Evolution API webhook handler
- Environment configuration management
- Development scripts (npm run dev)
- Docker configuration (Part 2)

### Technical Details
- Node.js with TypeScript
- Express.js for HTTP server
- SQLite for event storage
- FAISS for similarity search
- OpenAI API for LLM operations
- Evolution API for WhatsApp integration
