# Argus - Project Index

## Overview
**Argus** - An AI-powered system that extracts events, reminders, and scheduling information from WhatsApp messages.

> *Named after Argus Panoptes, the all-seeing giant of Greek mythology who never slept, always watching and remembering.*

**Current Version**: v0.5.0 (Auto-Learning System)

**Key Features**:
- Multi-language support (English, Hindi, Tamil, Telugu, Marathi, Bengali, Gujarati)
- Rule Engine with 70+ static patterns
- Auto-Learning System that improves over time
- Real-time metrics and monitoring
- Push notifications for reminders

---

## Tech Stack

| Component | Technology | Version |
|-----------|------------|---------|
| **Runtime** | Node.js (TypeScript) | 22.x |
| **Container** | Docker | 24.x |
| **WhatsApp API** | Evolution API (Baileys-based) | Latest |
| **Database** | SQLite (file-based) | better-sqlite3 12.x |
| **Vector Store** | Custom FAISS-like (file-backed) | - |
| **Message Broker** | Redis | 7.x |
| **Token Compression** | ktg-one/quicksave | - |
| **Web Framework** | Express.js | 5.x |
| **LLM Integration** | OpenAI API | 4.96.x |
| **Schema Validation** | Zod | 3.24.x |
| **Testing** | Vitest | 3.x |
| **WebSocket** | ws | 8.x |
| **Monitoring** | Grafana + Loki | Latest |

---

## Architecture

### Pipeline Flow (v0.5.0)
```
WhatsApp Message
    |
Evolution API Webhook
    |
Store Raw Message (SQLite)
    |
Heuristic Gate (Signal Detection)
    | (if signal found)
Small LLM Classifier (gpt-4o-mini)
    | (if relevant)
Context Builder + Token Compression
    |
Rule Engine (Static + Learned Patterns)
    |
    +--[High Confidence]--> Event Router
    |
    +--[Low Confidence]--> Big LLM Extraction (gpt-4o)
                               |
                           Log to llm_extraction_logs
                               |
                           Event Router
    |
[New Event] --> Insert DB --> Generate Embedding --> Store Vectors
[Update Event] --> Vector Search --> Update DB
[Signal Event] --> Dependency Search --> Activate Pending
    |
Notify Orchestrator --> Push Notification
```

### Auto-Learning Loop
```
LLM Extractions --> llm_extraction_logs
                           |
                    Pattern Learner (hourly)
                           |
                    Analyze & Validate
                           |
                    learned_patterns DB
                           |
                    Rule Engine Reload (5 min)
                           |
                    Better Rule Matching --> Fewer LLM Calls --> Cost Savings
```

---

## Project Structure

```
WHATSAPP-CHAT-RMD/
├── aidata/
│   └── prompt.md                # AI pipeline specification
├── src/
│   ├── index.ts                 # Main entry point
│   ├── server.ts                # Express server (v0.5.0)
│   ├── shared/
│   │   ├── types.ts             # Zod schemas & shared types
│   │   └── utils.ts             # Shared utilities
│   ├── config/
│   │   └── index.ts             # Configuration management
│   ├── orchestrator/
│   │   ├── index.ts             # Orchestrator main
│   │   ├── containerManager.ts  # Docker container management
│   │   ├── notificationService.ts # Web Push notifications
│   │   └── dashboardRouter.ts   # Dashboard API
│   ├── pipeline/
│   │   ├── index.ts             # Pipeline orchestration
│   │   ├── heuristicGate.ts     # Signal detection (regional languages)
│   │   ├── classifier.ts        # Small LLM classifier
│   │   ├── contextBuilder.ts    # Context aggregation
│   │   ├── tokenCompressor.ts   # Token compression
│   │   ├── ruleEngine.ts        # Rule-based extraction + dynamic patterns
│   │   ├── extractor.ts         # Big LLM extraction + logging
│   │   ├── patternLearner.ts    # Auto-learning service (NEW v0.5.0)
│   │   ├── intentDetector.ts    # Intent detection
│   │   └── eventRouter.ts       # Event routing logic
│   ├── database/
│   │   └── sqlite.ts            # SQLite operations + learning tables
│   ├── vector/
│   │   └── faiss.ts             # Vector store
│   ├── scheduler/
│   │   └── index.ts             # Scheduling service
│   ├── notifications/
│   │   └── index.ts             # Notification service
│   ├── webhook/
│   │   └── evolution.ts         # Evolution API webhook
│   └── utils/
│       ├── logger.ts            # Winston logger
│       ├── metrics.ts           # Pipeline metrics
│       └── pipelineLogger.ts    # Pipeline stage logging
├── tests/
│   ├── setup.ts                 # Test setup
│   ├── unit/
│   │   ├── heuristicGate.test.ts    # 27 tests
│   │   ├── classifier.test.ts        # Tests
│   │   ├── tokenCompressor.test.ts   # 11 tests
│   │   ├── extractor.test.ts         # 10 tests
│   │   ├── ruleEngine.test.ts        # 77 tests
│   │   ├── metrics.test.ts           # 51 tests
│   │   ├── patternLearner.test.ts    # 12 tests (NEW v0.5.0)
│   │   └── types.test.ts             # 13 tests
│   └── integration/
│       ├── pipeline.test.ts          # 8 tests
│       ├── api.test.ts               # 17 tests
│       └── database.test.ts          # 6 tests
├── webapp/
│   ├── server.ts                # Push notification server
│   └── public/
│       ├── index.html           # Web UI
│       ├── sw.js                # Service worker
│       └── manifest.json        # PWA manifest
├── docker/
│   ├── Dockerfile               # User container
│   ├── Dockerfile.orchestrator  # Orchestrator container
│   ├── Dockerfile.webapp        # Webapp container
│   ├── docker-compose.yml       # Full stack (production)
│   ├── docker-compose.dev.yml   # Development
│   └── grafana/                 # Grafana provisioning
├── scripts/
│   ├── start.sh                 # Start all services
│   ├── stop.sh                  # Stop all services
│   ├── whatsapp-login.sh        # WhatsApp QR login
│   └── test-message.sh          # Send test message
├── docs/
│   └── ARCHITECTURE.md          # Architecture diagrams
├── data/
│   ├── db/                      # SQLite database files
│   └── vectors/                 # Vector index files
├── INFO.md                      # This file - Project index
├── RULES.md                     # Project rules and guidelines
├── CHANGELOG.md                 # Version changelog
├── README.md                    # Quick start guide
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

---

## Database Tables

### Core Tables
| Table | Purpose |
|-------|---------|
| `messages` | All received messages with pipeline status |
| `events` | Extracted events and reminders |
| `subscriptions` | Push notification subscriptions |
| `pipeline_logs` | Pipeline execution logs |

### Auto-Learning Tables (v0.5.0)
| Table | Purpose |
|-------|---------|
| `llm_extraction_logs` | Logs of all LLM extractions |
| `learned_patterns` | Auto-generated regex patterns |
| `pattern_learning_runs` | Learning run history |

---

## Event Types

| Type | Description |
|------|-------------|
| `new_event` | New calendar event detected |
| `reminder` | Simple reminder (no specific time/date) |
| `update_event` | Modification to existing event |
| `cancel_event` | Cancel an existing event |
| `signal_event` | Trigger for conditional/pending event |
| `irrelevant` | Message not event-related |

---

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |

### Optional
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `NODE_ENV` | `development` | Environment |
| `DATABASE_PATH` | `./data/db/events.db` | SQLite file path |
| `OPENAI_MODEL_SMALL` | `gpt-4o-mini` | Classifier model |
| `OPENAI_MODEL_BIG` | `gpt-4o` | Extractor model |
| `TOKEN_THRESHOLD` | `2000` | Compression threshold |
| `PATTERN_LEARNING_INTERVAL` | `3600000` | Learning interval (ms) |
| `METRICS_LOG_INTERVAL` | `300000` | Metrics log interval (ms) |
| `LOG_LEVEL` | `debug` | Logging level |

---

## API Endpoints

### Core Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info & version |
| POST | `/webhook/evolution` | Evolution API webhook |
| POST | `/webhook/test` | Test message endpoint |
| GET | `/webhook/health` | Health check |
| GET | `/api/events` | List extracted events |
| GET | `/api/notifications` | Notification history |

### Metrics Endpoints (v0.4.1)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/metrics` | Full metrics object |
| GET | `/api/metrics/summary` | Human-readable summary |
| POST | `/api/metrics/reset` | Reset all metrics |

### Learning Endpoints (v0.5.0)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/learning/stats` | Pattern learning statistics |
| GET | `/api/learning/patterns` | List all learned patterns |
| GET | `/api/learning/logs` | LLM extraction logs |
| POST | `/api/learning/run` | Trigger manual learning |
| DELETE | `/api/learning/patterns/:id` | Deactivate a pattern |

---

## Quick Start

### Development
```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your OpenAI API key

# Start all services
./scripts/start.sh

# Or manually:
npm run dev              # Argus service
npm run webapp           # Push webapp

# Run tests
npm test -- --run
```

### Docker (Production)
```bash
# Build and start all services
docker compose -f docker/docker-compose.yml up -d

# With Evolution API (full stack)
docker compose -f docker/docker-compose.yml --profile full up -d

# View logs
docker compose -f docker/docker-compose.yml logs -f
```

---

## Testing

```bash
# Run all tests (237 tests)
npm test -- --run

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- --run tests/unit/ruleEngine.test.ts

# Watch mode
npm test -- --watch
```

### Test Coverage
| Module | Tests |
|--------|-------|
| Rule Engine | 77 |
| Metrics | 51 |
| Heuristic Gate | 27 |
| API Integration | 17 |
| Types | 13 |
| Pattern Learner | 12 |
| Token Compressor | 11 |
| Extractor | 10 |
| Pipeline Integration | 8 |
| Database Integration | 6 |
| **Total** | **237** |

---

## Related Documentation
- `docs/ARCHITECTURE.md` - Architecture diagrams (Mermaid)
- `RULES.md` - Coding guidelines and constraints
- `CHANGELOG.md` - Version history (newest first)
- `aidata/prompt.md` - AI pipeline specification
- `README.md` - Quick start guide
