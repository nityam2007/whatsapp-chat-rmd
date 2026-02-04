# Argus Architecture (v1.0.0)

> [!NOTE]
> This architecture is based on `docs/diagrams/archv2.mmd`, which is the Single Source of Truth for this system.

## Overview
Argus is a **Local-First, Vector-Based Memory System** for WhatsApp. It captures messages, extracts events, and provides proactive reminders using semantic search.

## Core Design Principles
1.  **WhatsApp as Primary Source**: All data ingestion starts from WhatsApp (via Evolution API).
2.  **Privacy First**: All data is stored locally in SQLite and FAISS. No cloud database.
3.  **Proactive Intelligence**: The system actively searches for relevant context on every new message.
4.  **Simple Stack**: Node.js + SQLite + FAISS (No complex vector DBs like Pinecone/Weaviate).

## System Components

### 1. Evolution API (Port 8080)
-   **Role**: WhatsApp Gateway.
-   **Function**: Connects to WhatsApp Cloud/Web, handles key-pairing, and sends webhooks to Argus.

### 2. Argus Backend (Port 3000)
-   **Role**: The Brain.
-   **Key Modules**:
    -   **Webhook Handler**: Receives messages from Evolution API.
    -   **Pipeline**: Deduplication -> Storage -> Embedding -> Compression.
    -   **Vector Store**: FAISS for semantic search (top-K retrieval).
    -   **Proactive Engine**: Triggers on every message to find related context.
    -   **LLM Interface**: Connects to Gemini 1M for heavy lifting (context validation).

### 3. Chrome Extension (Manifest V3)
-   **Role**: Contextual Trigger.
-   **Function**: Detects URLs (e.g., netflix.com, travel sites) to trigger proactive searches in Argus.
-   **Constraint**: No DOM reading for MVP. URL detection only.

### 4. Webapp Dashboard (Port 3002)
-   **Role**: User Interface.
-   **Function**: View messages, upcoming events, and manage system status.

## Data Flow
1.  **Ingestion**: Message -> Evolution API -> Webhook -> Argus.
2.  **Storage**:
    -   **SQLite**: Full message content, contacts, events.
    -   **FAISS**: Message embeddings for similarity search.
3.  **Proactive Loop**:
    -   New Message -> Embedding -> FAISS Search (Top 100) -> Gemini Context Window -> Notification.

## Directory Structure
-   `src/webhook`: Handling Evolution API requests.
-   `src/vector`: FAISS integration.
-   `src/database`: SQLite schema and queries.
-   `src/pipeline`: Message processing logic.
