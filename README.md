# Argus

**Argus** - AI-powered reminder and event extraction from WhatsApp messages.

> *Named after Argus Panoptes, the all-seeing giant of Greek mythology who never slept, always watching and remembering.*

**Current Version**: v0.7.5 | **LLM**: Gemini 3 Flash Preview

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
| `OPENAI_API_KEY` | OpenAI API key (fallback) |

### AI Model Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_MODEL` | Gemini model to use | `gemini-3-flash-preview` |
| `GEMINI_API_URL` | Gemini API endpoint | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `OPENAI_MODEL_SMALL` | Fast classifier model | `gpt-4o-mini` |
| `OPENAI_MODEL_BIG` | Extraction model | `gpt-4o` |

### Available Gemini Models

| Model | ID | Best For |
|-------|-----|----------|
| Gemini 3 Flash | `gemini-3-flash-preview` | Speed + intelligence (recommended) |
| Gemini 3 Pro | `gemini-3-pro-preview` | Complex tasks, best accuracy |
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
│   └── test-message.sh     # Send test message
├── src/
│   ├── index.ts            # Main entry point
│   ├── server.ts           # Express server
│   ├── pipeline/           # AI processing pipeline
│   ├── database/           # SQLite storage
│   └── webhook/            # Webhook handlers
├── webapp/
│   ├── server.ts           # Push notification server
│   └── public/             # Web interface
├── docs/
│   ├── ARCHITECTURE.md     # Mermaid diagrams
│   └── diagrams/           # Individual .mmd files
├── docker/                 # Docker configuration
├── data/                   # Runtime data (auto-created)
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
```

---

## License

MIT
