# Argus

**Argus** - AI-powered reminder and event extraction from WhatsApp messages.

> *Named after Argus Panoptes, the all-seeing giant of Greek mythology who never slept, always watching and remembering.*

**Current Version**: v1.0.0 | **LLM**: Gemini 3 Flash

## What's New in v1.0.0: Archv2 Simplified Pipeline

- **Simple pipeline**: dedup → store → heuristic → single-call Gemini extract
- **FAISS-backed semantic search** with persisted index + ID mapping
- **Legacy modules moved** to `src/legacy/` for clean archv2 core

## Proactive Triggers (v1.0.0)

Argus is now **proactive**, not just reactive. When you send ANY message, Argus intelligently checks if it relates to any pending tasks and reminds you automatically.

**Example:**
```
Task saved: "Get cashew from Goa for Priya"
... 3 months later ...
You send: "Just reached Goa!"
Argus sends Push notification: "You have a pending task: Get cashew from Goa for Priya"
```

This uses Gemini's 1M token context window for intelligent semantic matching - not just keywords.

> **Note:** WhatsApp is READ-ONLY. All reminders are sent via Web Push notifications.

---

## Quick Start (One Command)

### Prerequisites

- **Node.js 20+** - [Download](https://nodejs.org)
- **Docker** - [Download](https://docs.docker.com/get-docker/)
- **Gemini API Key** - [Get one](https://aistudio.google.com/apikey) (recommended)
- **OpenAI API Key** - [Get one](https://platform.openai.com/api-keys) (optional fallback)

### 1. Clone & Start

```bash
# Clone the repository
git clone https://github.com/your-username/WHATSAPP-CHAT-RMD.git
cd WHATSAPP-CHAT-RMD

# Copy environment file and add your API keys
cp .env.example .env
nano .env  # Add GEMINI_API_KEY (and optionally OPENAI_API_KEY)

# Make scripts executable and start everything
chmod +x scripts/*.sh
./scripts/start.sh
```

**That's it!** The start script will automatically:
- Install all dependencies (Argus + Evolution API)
- Start Docker containers (PostgreSQL, Redis)
- Run database migrations
- Start all Node.js services
- Show service status and URLs

### 2. Connect WhatsApp

```bash
./scripts/whatsapp-login.sh
```

Scan the QR code with your phone's WhatsApp to connect.

### 3. Test It

**Open Dashboard:** http://localhost:3002

**Send a Test Message:**
```bash
./scripts/test-message.sh "Meeting tomorrow at 3pm with the team"
```

### 4. Stop Services

```bash
./scripts/stop.sh           # Stop Node.js services only
./scripts/stop.sh --docker  # Stop everything including Docker
```

---

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Argus API | http://localhost:3000 | Main AI pipeline |
| Dashboard | http://localhost:3002 | Web UI for events/messages |
| Evolution API | http://localhost:8080 | WhatsApp gateway |
| PostgreSQL | localhost:5432 | Database for Evolution |
| Redis | localhost:6379 | Cache/queue |

---

## How WhatsApp Login Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Your Phone     │     │  Evolution API   │     │  Argus Service  │
│  (WhatsApp)     │     │  (WhatsApp Web)  │     │  (AI Pipeline)  │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                        │
         │  1. Scan QR Code      │                        │
         │──────────────────────>│                        │
         │                       │                        │
         │  2. Session Created   │                        │
         │<──────────────────────│                        │
         │                       │                        │
         │  3. You receive msg   │                        │
         │──────────────────────>│  4. Webhook POST       │
         │                       │───────────────────────>│
         │                       │                        │
         │                       │                        │  5. AI extracts
         │                       │                        │     event/reminder
         │                       │                        │
         │                       │                        │  6. Push notification
         │                       │                        │───────> 🔔
         │                       │                        │
```

**Key Points:**
- Evolution API acts as a WhatsApp Web client
- Uses the **Baileys** library (WhatsApp Web protocol)
- Your phone must stay connected to the internet
- All messages are processed locally (self-hosted)

---

## Architecture Diagrams

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for comprehensive Mermaid diagrams:
- System Architecture
- WhatsApp Login Flow
- AI Pipeline
- Push Notification Flow
- Database Schema

For detailed technical documentation of how the pipeline works, see [docs/WORKING.md](docs/WORKING.md).

Individual `.mmd` files in `docs/diagrams/` can be opened in [Mermaid Live Editor](https://mermaid.live)

---

## How Context Works

Argus uses conversational context to understand messages better:

### Context Window
- **Last 10 messages** from the same chat are included
- Helps the AI understand if a message is an update or new event

### Example: Implicit Update Detection
```
Message 1: "meeting tomorrow at 10 am"  → Creates event
Message 2: "now today at 10 PM"         → Updates the SAME event (not new!)
```

The AI detects that message 2 is updating message 1 because:
1. Both are from the same chat
2. Message 2 is a time-only statement (no new event name)
3. There's a recent event from that conversation

### Timezone Handling
- **All user times are interpreted as IST** (India Standard Time, UTC+5:30)
- Stored as UTC in database, displayed as IST in webapp
- Example: "10 AM" → stored as `04:30:00.000Z` (UTC) → shown as "10:00 AM IST"

---

## Proactive Triggers (v0.8.0)

Unlike traditional reminder apps that only store tasks, Argus is **proactive** - it reminds you when the context is right.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     INCOMING WHATSAPP MESSAGE                           │
│                "Just reached Goa, weather is amazing!"                  │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              1. PROACTIVE TRIGGER CHECK (runs for ALL messages)         │
│  - Load all pending events from database                                │
│  - Send to Gemini with intelligent prompt                               │
│  - Gemini: "User in Goa, pending task 'Get cashew from Goa'"           │
│  - Returns: { matched: true, confidence: 0.9 }                          │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              2. SEND PROACTIVE REMINDER                                 │
│  - WhatsApp: "You have a pending task: Get cashew from Goa"            │
│  - Web Push: Same notification                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Examples

| Your Message | Triggers This Task |
|--------------|-------------------|
| "Just reached Goa" | "Get cashew from Goa for Priya" |
| "Meeting with John went well" | "Ask John about the project" |
| "Feeling better now" | "Schedule doctor follow-up when better" |
| "The client approved!" | "Send invoice after approval" |
| "Finally got some free time" | Any pending leisure tasks |

### Configure Proactive Triggers

```env
# .env
ENABLE_PROACTIVE_TRIGGERS=true
PROACTIVE_CHECK_INTERVAL=60000  # Check every minute
```

---

## Alternative: Manual Start

If you prefer to start services manually:

```bash
# Terminal 1: Main Argus service
npm run dev

# Terminal 2: Push Notification webapp
npm run webapp
```

---

## Scripts Reference

| Script | Purpose |
|--------|---------|
| `./scripts/start.sh` | Start all services |
| `./scripts/stop.sh` | Stop all services |
| `./scripts/whatsapp-login.sh` | Connect WhatsApp via QR code |
| `./scripts/test-message.sh "msg"` | Send test message |

---

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `http://localhost:3000/` | GET | Service info |
| `http://localhost:3000/webhook/test` | POST | Submit test message |
| `http://localhost:3000/webhook/evolution` | POST | Evolution API webhook |
| `http://localhost:3000/webhook/health` | GET | Health check |
| `http://localhost:3000/api/events` | GET | List extracted events |
| `http://localhost:3000/api/notifications` | GET | Notification history |
| `http://localhost:3002/` | GET | Push notification webapp |

---

## Connect to WhatsApp (Evolution API)

For actual WhatsApp integration, you need Evolution API:

### Option A: Docker (Recommended)

```bash
# Start with Evolution API
docker-compose -f docker/docker-compose.yml --profile full up -d

# Open Evolution API dashboard
open http://localhost:8080
```

### Option B: External Evolution API

1. Set up Evolution API elsewhere
2. Update `.env`:
   ```
   EVOLUTION_API_URL=http://your-evolution-api:8080
   EVOLUTION_API_KEY=your_api_key
   ```
3. Configure webhook in Evolution API to point to:
   ```
   http://your-server:3000/webhook/evolution
   ```

---

## Environment Variables

### Required (choose one)

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key (recommended) |
| `OPENAI_API_KEY` | OpenAI API key (embeddings fallback) |

### AI Model Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_MODEL` | Gemini model to use | `gemini-3-flash-preview` |
| `GEMINI_API_URL` | Gemini API endpoint | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `OPENAI_EMBEDDING_MODEL` | Embedding model | `text-embedding-3-small` |

### Available Gemini Models

| Model | ID | Best For |
|-------|-----|----------|
| Gemini 3 Flash | `gemini-3-flash-preview` | High-speed, cost-efficient, low-latency |
| Gemini 3 Pro | `gemini-3-pro-preview` | Advanced reasoning + complex workflows |
| Gemini 2.5 Flash | `gemini-2.5-flash` | Previous generation |

### Other Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Argus API port | `3000` |
| `VAPID_PUBLIC_KEY` | Push notification key | Auto-generated |
| `VAPID_PRIVATE_KEY` | Push notification key | Auto-generated |
| `LOG_LEVEL` | Logging level | `debug` |

---

## Project Structure

```
WHATSAPP-CHAT-RMD/
├── scripts/
│   ├── start.sh            # Start all services
│   ├── stop.sh             # Stop all services
│   ├── whatsapp-login.sh   # WhatsApp QR login
│   ├── test-message.sh     # Send test message
│   ├── e2e-test.ts         # Full E2E test suite
│   └── e2e-quick.ts        # Quick E2E test runner
├── src/
│   ├── index.ts            # Main entry point
│   ├── server.ts           # Express server
│   ├── pipeline/           # AI processing pipeline
│   ├── database/           # SQLite storage
│   ├── webhook/            # Webhook handlers
│   └── utils/
│       ├── logger.ts       # Winston logger
│       ├── metrics.ts      # Pipeline metrics
│       └── loudLogger.ts   # Loud visual logging
├── webapp/
│   ├── server.ts           # Push notification server
│   └── public/             # Web interface
├── docs/
│   ├── ARCHITECTURE.md     # Mermaid diagrams
│   ├── WORKING.md          # Technical documentation
│   └── diagrams/           # Individual .mmd files
├── docker/                 # Docker configuration
├── data/
│   ├── db/                 # SQLite database
│   ├── vectors/            # Vector index files
│   └── logs/               # Pipeline & LLM logs
└── logs/                   # Log files (auto-created)
```

---

## Development

```bash
# Run tests
npm run test:run

# Run with watch mode
npm run test

# Build for production
npm run build

# Run E2E tests
npm run e2e-test          # Full test suite (8 scenarios)
npm run e2e-quick 1       # Quick single test (scenario 1-8)
```

---

## Troubleshooting

### "OPENAI_API_KEY not set"
Edit `.env` and add your OpenAI API key.

### Port already in use
```bash
# Kill existing processes
./scripts/stop.sh

# Or manually
pkill -f "tsx watch"
```

### Push notifications not working
1. Make sure VAPID keys are generated (check `.env`)
2. Open `http://localhost:3002` and check status
3. Browser must support push notifications (Chrome, Firefox, Edge)

### View logs
```bash
tail -f logs/rmd.log      # Main service
tail -f logs/webapp.log   # Push notification webapp
tail -f data/logs/errors.log   # Errors only
tail -f data/logs/llm.log      # LLM calls summary
```

---

## License

MIT
