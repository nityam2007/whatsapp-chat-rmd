# Changelog

All notable changes to this project will be documented in this file.
New entries are added at the TOP of this file (append-only, newest first).

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
