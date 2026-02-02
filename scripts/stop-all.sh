#!/bin/bash

# ===========================================
# WhatsApp Chat RMD - Stop All Services
# ===========================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${YELLOW}Stopping all services...${NC}"

# Kill from PID file
if [ -f ".pids" ]; then
    while read pid; do
        if kill -0 $pid 2>/dev/null; then
            kill $pid 2>/dev/null
            echo -e "${GREEN}  ✓ Stopped process $pid${NC}"
        fi
    done < .pids
    rm -f .pids
fi

# Kill any remaining Node processes
pkill -f "tsx.*src/index.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped RMD${NC}" || true
pkill -f "tsx.*webapp/server.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped Webapp${NC}" || true
pkill -f "tsx.*evolution-api" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped Evolution API${NC}" || true
pkill -f "evolution-api.*main.ts" 2>/dev/null || true

echo ""
echo -e "${YELLOW}Stop PostgreSQL too? (y/n)${NC}"
read -r response

if [[ "$response" =~ ^[Yy]$ ]]; then
    docker stop rmd-postgres 2>/dev/null && echo -e "${GREEN}  ✓ Stopped PostgreSQL${NC}" || true
fi

echo -e "${GREEN}All services stopped${NC}"
