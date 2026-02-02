#!/bin/bash

# ===========================================
# WhatsApp Chat RMD - Stop Script
# ===========================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${YELLOW}Stopping all services...${NC}"

# Kill processes from PID file
if [ -f ".pids" ]; then
    while read pid; do
        if kill -0 $pid 2>/dev/null; then
            kill $pid 2>/dev/null
            echo -e "${GREEN}  ✓ Stopped process $pid${NC}"
        fi
    done < .pids
    rm .pids
fi

# Kill any remaining processes
pkill -f "tsx.*src/index.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped RMD service${NC}" || true
pkill -f "tsx.*src/orchestrator/index.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped orchestrator${NC}" || true
pkill -f "tsx.*webapp/server.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped webapp${NC}" || true

echo -e "${GREEN}All services stopped${NC}"
