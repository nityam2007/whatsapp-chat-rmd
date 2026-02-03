#!/bin/bash

# ===========================================
# Argus - Stop Script
# ===========================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${YELLOW}Stopping all services...${NC}"
echo ""

# ===========================================
# Stop Node.js processes
# ===========================================
echo -e "${BLUE}Stopping Node.js services...${NC}"

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
pkill -f "tsx.*src/index.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped Argus API${NC}" || true
pkill -f "tsx.*src/orchestrator/index.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped orchestrator${NC}" || true
pkill -f "tsx.*webapp/server.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped webapp${NC}" || true
pkill -f "tsx.*evolution-api/src/main.ts" 2>/dev/null && echo -e "${GREEN}  ✓ Stopped Evolution API${NC}" || true
pkill -f "tsx watch.*evolution-api" 2>/dev/null || true

# ===========================================
# Optionally stop Docker containers
# ===========================================
echo ""
echo -e "${BLUE}Docker containers status:${NC}"

# Check if containers are running
POSTGRES_RUNNING=$(docker ps --format '{{.Names}}' | grep -c "^evolution-postgres$" || true)
REDIS_RUNNING=$(docker ps --format '{{.Names}}' | grep -c "^argus-redis$" || true)

if [ "$POSTGRES_RUNNING" -gt 0 ]; then
    echo -e "${YELLOW}  PostgreSQL is running (evolution-postgres)${NC}"
fi

if [ "$REDIS_RUNNING" -gt 0 ]; then
    echo -e "${YELLOW}  Redis is running (argus-redis)${NC}"
fi

# Ask if user wants to stop Docker containers
if [ "$POSTGRES_RUNNING" -gt 0 ] || [ "$REDIS_RUNNING" -gt 0 ]; then
    echo ""
    read -p "Stop Docker containers too? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [ "$POSTGRES_RUNNING" -gt 0 ]; then
            docker stop evolution-postgres > /dev/null 2>&1
            echo -e "${GREEN}  ✓ Stopped PostgreSQL${NC}"
        fi
        if [ "$REDIS_RUNNING" -gt 0 ]; then
            docker stop argus-redis > /dev/null 2>&1
            echo -e "${GREEN}  ✓ Stopped Redis${NC}"
        fi
    else
        echo -e "${YELLOW}  Docker containers left running${NC}"
    fi
fi

echo ""
echo -e "${GREEN}All Node.js services stopped${NC}"
