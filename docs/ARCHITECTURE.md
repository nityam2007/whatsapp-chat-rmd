# Argus - Architecture & Flow Diagrams

Open these diagrams in any Mermaid viewer:
- [Mermaid Live Editor](https://mermaid.live)
- VS Code with Mermaid extension
- GitHub (renders automatically in .md files)

---

## 1. System Architecture Overview

```mermaid
graph TB
    subgraph "User's Phone"
        WA[WhatsApp App]
    end

    subgraph "WhatsApp Cloud"
        WAC[WhatsApp Servers]
    end

    subgraph "Your Server"
        subgraph "Evolution API Container"
            EVO[Evolution API<br/>Port 8080]
            BAILEYS[Baileys Library<br/>WhatsApp Web Protocol]
        end

        subgraph "Argus Service Container"
            WEBHOOK[Webhook Handler<br/>POST /webhook/evolution]
            PIPELINE[AI Pipeline]
            RULEENG[Rule Engine<br/>+ Auto-Learning]
            DB[(SQLite DB)]
            VECTOR[(Vector Store<br/>FAISS)]
            SCHEDULER[Scheduler]
        end

        subgraph "Push Webapp Container"
            PUSHAPI[Push API<br/>Port 3002]
            SW[Service Worker]
        end

        subgraph "Monitoring Stack"
            GRAFANA[Grafana<br/>Port 3001]
            LOKI[Loki<br/>Port 3100]
            PROMTAIL[Promtail]
        end

        REDIS[(Redis<br/>Pub/Sub + Cache)]
    end

    subgraph "External Services"
        GEMINI[Gemini API]
        OPENAI[OpenAI API<br/>Classifier]
    end

    subgraph "User's Browser"
        BROWSER[Browser<br/>Push Notifications]
    end

    WA <--> WAC
    WAC <--> BAILEYS
    BAILEYS --> EVO
    EVO -->|Webhook POST| WEBHOOK
    WEBHOOK --> PIPELINE
    PIPELINE --> RULEENG
    RULEENG -->|Complex cases| GEMINI
    PIPELINE --> DB
    PIPELINE --> VECTOR
    PIPELINE -->|Schedule Reminders| SCHEDULER
    SCHEDULER -->|Send Notification| PUSHAPI
    PUSHAPI -->|Web Push| BROWSER
    
    EVO <--> REDIS
    PIPELINE <--> REDIS
    PIPELINE --> LOKI
    LOKI --> GRAFANA

    style WA fill:#25D366,color:#fff
    style EVO fill:#6366f1,color:#fff
    style PIPELINE fill:#8b5cf6,color:#fff
    style RULEENG fill:#f59e0b,color:#fff
    style GEMINI fill:#4285f4,color:#fff
    style OPENAI fill:#10a37f,color:#fff
    style BROWSER fill:#f59e0b,color:#fff
```

---

## 2. Message Processing Pipeline (v0.7.1)

```mermaid
flowchart TD
    subgraph "Input"
        MSG[Incoming WhatsApp Message]
    end

    subgraph "Stage 1: Heuristic Gate"
        H1{Contains keywords?<br/>tomorrow, meeting,<br/>remind, kal, baje...}
        H2[Calculate Signal Score]
    end

    subgraph "Stage 2: Small LLM Classification"
        C1[GPT-4o-mini]
        C2{Event Type?}
        C3[new_event]
        C4[reminder]
        C5[update_event]
        C6[cancel_event]
        C7[irrelevant]
    end

    subgraph "Stage 3: Context Building"
        CTX1[Fetch Recent Messages<br/>Same Chat]
        CTX2[Search Similar Events<br/>Vector Store]
        CTX3[Build Context Window]
    end

    subgraph "Stage 4: Token Compression"
        TC1{Tokens > 2000?}
        TC2[Compress with Quicksave]
        TC3[Keep Original]
    end

    subgraph "Stage 5: Rule Engine + Auto-Learning"
        RE1[Rule Engine<br/>Static + Learned Patterns]
        RE2{Confidence >= 0.75<br/>AND hasTime?}
        RE3[Skip LLM]
        RE4[Use LLM]
    end

    subgraph "Stage 6: Big LLM Extraction"
        E1[Gemini 3 Flash]
        E2[Extract Structured Data]
        E3[Log to llm_extraction_logs]
    end

    subgraph "Stage 7: Event Routing"
        R1{Event Type}
        R2[Store New Event]
        R3[Update Existing]
        R4[Cancel Event]
        R5[Schedule Reminder]
    end

    subgraph "Output"
        OUT1[(SQLite DB)]
        OUT2[(Vector Store)]
        OUT3[Scheduler]
        OUT4[Push Notification]
    end

    MSG --> H1
    H1 -->|No Signal| DROP[Drop Message]
    H1 -->|Has Signal| H2
    H2 --> C1
    C1 --> C2
    C2 --> C3 & C4 & C5 & C6 & C7
    C7 --> DROP
    C3 & C4 & C5 & C6 --> CTX1
    CTX1 --> CTX2
    CTX2 --> CTX3
    CTX3 --> TC1
    TC1 -->|Yes| TC2
    TC1 -->|No| TC3
    TC2 & TC3 --> RE1
    RE1 --> RE2
    RE2 -->|Yes| RE3
    RE2 -->|No| RE4
    RE3 --> R1
    RE4 --> E1
    E1 --> E2
    E2 --> E3
    E3 --> R1
    R1 -->|new_event| R2
    R1 -->|update| R3
    R1 -->|cancel| R4
    R1 -->|reminder| R5
    R2 & R3 --> OUT1
    R2 --> OUT2
    R5 --> OUT3
    OUT3 --> OUT4

    style MSG fill:#25D366,color:#fff
    style C1 fill:#10a37f,color:#fff
    style E1 fill:#4285f4,color:#fff
    style RE1 fill:#f59e0b,color:#fff
    style OUT4 fill:#f59e0b,color:#fff
    style DROP fill:#ef4444,color:#fff
```

---

## 3. Auto-Learning System (v0.7.1)

```mermaid
flowchart TB
    subgraph "Runtime Processing"
        MSG[Message: "meeting 3 baje"]
        RE[Rule Engine<br/>Static + Dynamic Patterns]
        LLM[LLM Extraction<br/>Gemini 3 Flash]
        LOG[Log to llm_extraction_logs]
    end

    subgraph "Hourly Pattern Learning"
        CRON[Scheduled Task<br/>Every Hour]
        ANALYZE[Analyze Extraction Logs]
        FIND[Find Common Patterns]
        VALID[Validate Against History<br/>70%+ Precision Required]
        STORE[Store in learned_patterns]
    end

    subgraph "Pattern Reload"
        RELOAD[Reload Check<br/>Every 5 Minutes]
        LOAD[Load New Patterns<br/>Into Rule Engine]
    end

    subgraph "Feedback Loop"
        TRACK[Track Hit/Miss<br/>Per Pattern]
        DEACT[Auto-Deactivate<br/>Low Accuracy Patterns<br/>< 50% after 10 attempts]
    end

    MSG --> RE
    RE -->|confidence < 0.75| LLM
    LLM --> LOG
    LOG --> CRON
    CRON --> ANALYZE
    ANALYZE --> FIND
    FIND --> VALID
    VALID --> STORE
    STORE --> RELOAD
    RELOAD --> LOAD
    LOAD --> RE
    RE --> TRACK
    TRACK --> DEACT

    style MSG fill:#25D366,color:#fff
    style RE fill:#f59e0b,color:#fff
    style LLM fill:#4285f4,color:#fff
    style CRON fill:#6366f1,color:#fff
    style STORE fill:#8b5cf6,color:#fff
```

### Pattern Learning Algorithm

1. **Collect Logs**: Gather LLM extractions with confidence >= 0.8
2. **Analyze Patterns**: Look for common patterns:
   - Time patterns: "X baje", "around X pm", "by X am"
   - Date patterns: "agle monday", "coming friday", "end of week"
   - Action patterns: "need to X", "mujhe X karna hai"
3. **Validate**: Require 3+ examples, 70%+ precision
4. **Store**: Add validated patterns to database
5. **Track**: Monitor hit/miss rates
6. **Deactivate**: Remove patterns with <50% accuracy after 10+ attempts

---

## 4. Database Schema (v0.7.1)

```mermaid
erDiagram
    MESSAGES {
        string id PK
        string chat_id
        string sender
        string content
        int timestamp
        boolean processed
        boolean heuristic_passed
        float heuristic_score
        string heuristic_signals
        string classification_type
        float classification_confidence
        boolean extraction_success
        string extraction_event_id FK
        boolean pipeline_completed
        string pipeline_error
        string created_at
    }

    EVENTS {
        string id PK
        string title
        string start_time
        string end_time
        string condition_type
        string condition_value
        string status
        float confidence
        string source_message_id FK
        string chat_id
        string participants
        string created_by
        string created_at
        string updated_at
    }

    LLM_EXTRACTION_LOGS {
        string id PK
        string message_id FK
        string raw_message
        string normalized_message
        string event_type
        string extracted_title
        string extracted_time
        string extracted_date
        string extracted_participants
        string llm_model
        int llm_tokens_used
        int llm_latency_ms
        float confidence
        boolean rule_engine_tried
        float rule_engine_confidence
        string created_at
    }

    LEARNED_PATTERNS {
        string id PK
        string pattern_type
        string regex_pattern
        string capture_groups
        string examples
        int hit_count
        int miss_count
        float accuracy
        boolean is_active
        int priority
        string created_from_logs
        string created_at
        string last_validated_at
        string last_hit_at
    }

    PATTERN_LEARNING_RUNS {
        string id PK
        string started_at
        string completed_at
        int logs_analyzed
        int patterns_generated
        int patterns_validated
        int patterns_added
        string status
        string error
    }

    SUBSCRIPTIONS {
        string id PK
        string endpoint
        string p256dh_key
        string auth_key
        string created_at
    }

    MESSAGES ||--o{ EVENTS : "extracts"
    MESSAGES ||--o{ LLM_EXTRACTION_LOGS : "generates"
    LLM_EXTRACTION_LOGS }o--|| LEARNED_PATTERNS : "creates"
```

---

## 5. WhatsApp Login Flow (QR Code)

```mermaid
sequenceDiagram
    autonumber
    participant User as User
    participant Phone as WhatsApp Phone
    participant Script as Login Script
    participant EVO as Evolution API
    participant WA as WhatsApp Servers

    User->>Script: Run ./scripts/whatsapp-login.sh
    Script->>EVO: POST /instance/create
    EVO-->>Script: Instance created
    
    Script->>EVO: GET /instance/connect/{name}
    EVO->>WA: Request QR Code
    WA-->>EVO: QR Code Data
    EVO-->>Script: QR Code (base64 + text)
    
    Script-->>User: Display QR Code
    
    Note over User,Phone: User opens WhatsApp on phone
    User->>Phone: Menu > Linked Devices > Link
    Phone->>Phone: Camera scans QR code
    
    Phone->>WA: Authenticate with QR
    WA->>WA: Verify & Create Session
    WA-->>Phone: Session Confirmed
    WA-->>EVO: Connection Established
    
    EVO-->>Script: State: "open"
    Script-->>User: Connected!

    Note over EVO,WA: Now all messages flow through Evolution API
    
    loop Every Message Received
        WA->>EVO: New Message
        EVO->>Script: Webhook POST
    end
```

---

## 6. Complete Data Flow

```mermaid
flowchart LR
    subgraph Phone["Phone"]
        WA[WhatsApp]
    end

    subgraph Cloud["WhatsApp Cloud"]
        WAS[WhatsApp Servers]
    end

    subgraph Server["Your Server"]
        EVO[Evolution API<br/>:8080]
        
        subgraph ARGUS["Argus Service :3000"]
            WH[Webhook]
            HG[Heuristic Gate]
            CL[Classifier<br/>gpt-4o-mini]
            CB[Context Builder]
            RE[Rule Engine<br/>+ Learning]
            EX[Extractor<br/>Gemini 3 Flash]
            ER[Event Router]
        end
        
        subgraph Storage["Storage"]
            SQL[(SQLite)]
            VEC[(Vectors)]
        end
        
        SCH[Scheduler]
        PUSH[Push Service<br/>:3002]
    end

    subgraph Browser["Browser"]
        SW[Service Worker]
        NOT[Notification]
    end

    subgraph OpenAI["AI Services"]
        CLASSIFIER[OpenAI<br/>Classifier]
        GEMINI[Gemini<br/>Extractor]
    end

    WA <-->|Messages| WAS
    WAS <-->|Baileys Protocol| EVO
    EVO -->|POST /webhook| WH
    WH --> HG
    HG -->|Pass| CL
    CL -->|Classify| CLASSIFIER
    CLASSIFIER -->|Event Type| CL
    CL --> CB
    CB --> RE
    RE -->|High Confidence| ER
    RE -->|Low Confidence| EX
    EX -->|Extract| GEMINI
    GEMINI -->|Structured Data| EX
    EX --> ER
    ER --> SQL
    ER --> VEC
    ER --> SCH
    SCH -->|When Time| PUSH
    PUSH -->|Web Push| SW
    SW --> NOT

    style WA fill:#25D366,color:#fff
    style CLASSIFIER fill:#10a37f,color:#fff
    style GEMINI fill:#4285f4,color:#fff
    style RE fill:#f59e0b,color:#fff
    style NOT fill:#f59e0b,color:#fff
```

---

## 7. Push Notification Flow

```mermaid
sequenceDiagram
    autonumber
    participant Browser as Browser
    participant SW as Service Worker
    participant WebApp as Push Webapp :3002
    participant ARGUS as Argus Service
    participant Scheduler as Scheduler

    Note over Browser,WebApp: Initial Setup (One Time)
    Browser->>WebApp: Open http://localhost:3002
    WebApp-->>Browser: Return HTML + JS
    Browser->>Browser: Register Service Worker
    Browser->>Browser: Request Notification Permission
    Browser->>WebApp: GET /api/vapid-public-key
    WebApp-->>Browser: VAPID Public Key
    Browser->>Browser: Create Push Subscription
    Browser->>WebApp: POST /api/subscribe
    WebApp->>WebApp: Store Subscription
    WebApp-->>Browser: Subscribed

    Note over ARGUS,Scheduler: When Event is Detected
    ARGUS->>ARGUS: Extract Event from Message
    ARGUS->>Scheduler: Schedule Reminder
    
    Note over Scheduler,Browser: When Reminder Time Arrives
    Scheduler->>WebApp: POST /api/notify
    WebApp->>WebApp: Load Subscription
    WebApp->>SW: Web Push (VAPID signed)
    SW->>SW: Receive Push Event
    SW->>Browser: showNotification()
    Browser-->>Browser: Display Notification

    Note over Browser: User Interaction
    Browser->>SW: notificationclick
    SW->>Browser: Focus/Open App
```

---

## 8. Multi-Container Architecture

```mermaid
graph TB
    subgraph "Docker Network: rmd-network"
        subgraph "Core Services"
            ARGUS[Argus Service<br/>:3000<br/>Main App]
            REDIS[(Redis<br/>:6379<br/>Cache + Rate Limit)]
        end

        subgraph "WhatsApp Integration"
            EVO[Evolution API<br/>:8080]
            PG[(PostgreSQL<br/>:5432)]
        end

        subgraph "Monitoring"
            GRAFANA[Grafana<br/>:3001]
            LOKI[Loki<br/>:3100]
            PROMTAIL[Promtail]
        end

        subgraph "Push Service"
            PUSH[Push Webapp<br/>:3002]
        end
    end

    subgraph "External"
        GEMINI[Gemini API]
        OPENAI[OpenAI API]
        BROWSERS[User Browsers]
    end

    EVO --> ARGUS
    ARGUS <--> REDIS
    ARGUS --> GEMINI
    ARGUS --> OPENAI
    ARGUS --> LOKI
    LOKI --> GRAFANA
    ARGUS --> PUSH
    PUSH --> BROWSERS
    EVO --> PG

    style ARGUS fill:#6366f1,color:#fff
    style REDIS fill:#dc2626,color:#fff
    style EVO fill:#8b5cf6,color:#fff
    style PUSH fill:#f59e0b,color:#fff
    style GRAFANA fill:#f97316,color:#fff
    style GEMINI fill:#4285f4,color:#fff
```

---

## 9. Heuristic Gate Keywords

```mermaid
mindmap
  root((Heuristic<br/>Gate))
    Time Signals
      tomorrow/kal
      today/aaj
      tonight/raat ko
      next week
      at X pm/am
      X baje
      this weekend
    Event Keywords
      meeting
      appointment
      call
      interview
      deadline
      exam/quiz/viva
      birthday
    Reminder Phrases
      remind me
      don't forget
      yaad dilana
      bhoolna mat
      alert me
    Action Words
      schedule
      book/reserve
      plan
      cancel
      reschedule
    Regional Languages
      Tamil: inru, naalai
      Telugu: eeroju, repu
      Marathi: udya, aaj
      Bengali: aj, kal
      Gujarati: aaje, kale
```

---

## 10. Metrics & Monitoring

```mermaid
flowchart LR
    subgraph "Pipeline Metrics"
        M1[messagesProcessed]
        M2[heuristicDrops/Passes]
        M3[ruleEngineExtractions]
        M4[llmExtractions]
        M5[eventsCreated/Updated]
        M6[errors]
    end

    subgraph "Derived Rates"
        R1[heuristicDropRate]
        R2[ruleEngineHitRate]
        R3[llmSkipRate]
        R4[errorRate]
    end

    subgraph "API Endpoints"
        A1[GET /api/metrics]
        A2[GET /api/metrics/summary]
        A3[POST /api/metrics/reset]
    end

    subgraph "Learning Stats"
        L1[GET /api/learning/stats]
        L2[GET /api/learning/patterns]
        L3[GET /api/learning/logs]
        L4[POST /api/learning/run]
    end

    M1 & M2 & M3 & M4 & M5 & M6 --> R1 & R2 & R3 & R4
    R1 & R2 & R3 & R4 --> A1 & A2
    A3 --> M1

    style M1 fill:#6366f1,color:#fff
    style R1 fill:#8b5cf6,color:#fff
    style A1 fill:#10a37f,color:#fff
    style L1 fill:#f59e0b,color:#fff
```

---

## API Endpoints Reference

### Argus Service (:3000)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service info & version |
| POST | `/webhook/evolution` | Evolution API webhook |
| POST | `/webhook/test` | Test message endpoint |
| GET | `/webhook/health` | Health check |
| GET | `/api/events` | List extracted events |
| GET | `/api/notifications` | Notification history |
| GET | `/api/metrics` | Pipeline metrics |
| GET | `/api/metrics/summary` | Human-readable metrics |
| POST | `/api/metrics/reset` | Reset metrics |
| GET | `/api/learning/stats` | Pattern learning stats |
| GET | `/api/learning/patterns` | List learned patterns |
| GET | `/api/learning/logs` | LLM extraction logs |
| POST | `/api/learning/run` | Trigger pattern learning |
| DELETE | `/api/learning/patterns/:id` | Deactivate pattern |

### Push Webapp (:3002)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web interface |
| GET | `/health` | Health check |
| GET | `/api/vapid-public-key` | VAPID public key |
| POST | `/api/subscribe` | Register subscription |
| POST | `/api/notify` | Send notification |

---

## Quick Reference Commands

```bash
# Start all services
./scripts/start.sh

# Stop all services
./scripts/stop.sh

# Login to WhatsApp (requires Evolution API)
./scripts/whatsapp-login.sh

# Send test message
./scripts/test-message.sh "Meeting tomorrow at 3pm"

# Run with Docker
docker compose -f docker/docker-compose.yml up -d

# With Evolution API (full stack)
docker compose -f docker/docker-compose.yml --profile full up -d

# View logs
docker compose -f docker/docker-compose.yml logs -f

# Run tests
npm test -- --run

# Check metrics
curl http://localhost:3000/api/metrics/summary

# Check learning stats
curl http://localhost:3000/api/learning/stats

# Trigger pattern learning
curl -X POST http://localhost:3000/api/learning/run
```

---

## Version History

| Version | Features |
|---------|----------|
| v0.1.0 | Initial pipeline, SQLite, FAISS |
| v0.2.0 | Multi-container, Redis, WebSocket |
| v0.3.0 | Startup scripts, Push webapp |
| v0.4.0 | Rule engine, Regional languages (77 tests) |
| v0.4.1 | Metrics system (51 tests) |
| v0.5.0 | Auto-Learning System (237 tests) |
| v0.6.0 | Pending confirmation, Gemini integration |
| v0.7.0 | Dashboard UI redesign, Gemini 2.5 Flash |
| v0.7.1 | Gemini 3 Flash upgrade, metrics fix |
