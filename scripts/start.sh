#!/bin/bash

# ===========================================
# WhatsApp Chat RMD - Startup Script
# ===========================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to project directory
cd "$PROJECT_DIR"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║          WhatsApp Chat RMD - Startup Script               ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ===========================================
# Check prerequisites
# ===========================================
check_prerequisites() {
    echo -e "${YELLOW}Checking prerequisites...${NC}"
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is not installed${NC}"
        echo "Install Node.js 20+ from https://nodejs.org"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        echo -e "${RED}Error: Node.js 20+ required (found v$NODE_VERSION)${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}Error: npm is not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ npm $(npm -v)${NC}"
    
    # Check if dependencies are installed
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}Installing dependencies...${NC}"
        npm install
    fi
    echo -e "${GREEN}  ✓ Dependencies installed${NC}"
}

# ===========================================
# Setup environment
# ===========================================
setup_environment() {
    echo -e "${YELLOW}Setting up environment...${NC}"
    
    # Create .env if it doesn't exist
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            echo -e "${YELLOW}  Created .env from .env.example${NC}"
            echo -e "${YELLOW}  Please edit .env and add your OPENAI_API_KEY${NC}"
        fi
    fi
    
    # Load environment variables
    if [ -f ".env" ]; then
        export $(grep -v '^#' .env | xargs)
    fi
    
    # Generate VAPID keys if not set
    if [ -z "$VAPID_PUBLIC_KEY" ] || [ -z "$VAPID_PRIVATE_KEY" ]; then
        echo -e "${YELLOW}  Generating VAPID keys for push notifications...${NC}"
        VAPID_KEYS=$(npx web-push generate-vapid-keys --json 2>/dev/null)
        VAPID_PUBLIC=$(echo "$VAPID_KEYS" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
        VAPID_PRIVATE=$(echo "$VAPID_KEYS" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)
        
        # Update .env file
        if [ -n "$VAPID_PUBLIC" ] && [ -n "$VAPID_PRIVATE" ]; then
            sed -i "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$VAPID_PUBLIC|" .env
            sed -i "s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=$VAPID_PRIVATE|" .env
            export VAPID_PUBLIC_KEY="$VAPID_PUBLIC"
            export VAPID_PRIVATE_KEY="$VAPID_PRIVATE"
            echo -e "${GREEN}  ✓ VAPID keys generated${NC}"
        fi
    else
        echo -e "${GREEN}  ✓ VAPID keys already configured${NC}"
    fi
    
    # Create data directories
    mkdir -p data/db data/vectors
    echo -e "${GREEN}  ✓ Data directories created${NC}"
}

# ===========================================
# Start services
# ===========================================
start_services() {
    echo ""
    echo -e "${YELLOW}Starting services...${NC}"
    
    # Kill any existing processes on our ports
    echo -e "${YELLOW}  Cleaning up existing processes...${NC}"
    pkill -f "tsx.*src/index.ts" 2>/dev/null || true
    pkill -f "tsx.*src/orchestrator/index.ts" 2>/dev/null || true
    pkill -f "tsx.*webapp/server.ts" 2>/dev/null || true
    sleep 1
    
    # Start main RMD service
    echo -e "${BLUE}  Starting WhatsApp RMD service on port 3000...${NC}"
    npm run dev > logs/rmd.log 2>&1 &
    RMD_PID=$!
    echo "  PID: $RMD_PID"
    
    # Start webapp for push notifications
    echo -e "${BLUE}  Starting Push Notification webapp on port 3002...${NC}"
    npx tsx webapp/server.ts > logs/webapp.log 2>&1 &
    WEBAPP_PID=$!
    echo "  PID: $WEBAPP_PID"
    
    # Save PIDs to file for cleanup
    echo "$RMD_PID" > .pids
    echo "$WEBAPP_PID" >> .pids
    
    # Wait for services to start
    echo ""
    echo -e "${YELLOW}Waiting for services to start...${NC}"
    sleep 3
    
    # Check if services are running
    if kill -0 $RMD_PID 2>/dev/null; then
        echo -e "${GREEN}  ✓ RMD service started${NC}"
    else
        echo -e "${RED}  ✗ RMD service failed to start${NC}"
        echo "Check logs/rmd.log for details"
    fi
    
    if kill -0 $WEBAPP_PID 2>/dev/null; then
        echo -e "${GREEN}  ✓ Webapp started${NC}"
    else
        echo -e "${RED}  ✗ Webapp failed to start${NC}"
        echo "Check logs/webapp.log for details"
    fi
}

# ===========================================
# Show status and URLs
# ===========================================
show_status() {
    echo ""
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                  Services Running                         ║"
    echo "╠═══════════════════════════════════════════════════════════╣"
    echo "║                                                           ║"
    echo "║  RMD API:      http://localhost:3000                      ║"
    echo "║  Push Webapp:  http://localhost:3002                      ║"
    echo "║                                                           ║"
    echo "╠═══════════════════════════════════════════════════════════╣"
    echo "║  Test Endpoints:                                          ║"
    echo "║    POST /webhook/test    - Submit test message            ║"
    echo "║    GET  /webhook/health  - Health check                   ║"
    echo "║    GET  /api/events      - List events                    ║"
    echo "║    GET  /api/notifications - Notification history         ║"
    echo "║                                                           ║"
    echo "╠═══════════════════════════════════════════════════════════╣"
    echo "║  Logs:                                                    ║"
    echo "║    tail -f logs/rmd.log      - RMD service logs           ║"
    echo "║    tail -f logs/webapp.log   - Webapp logs                ║"
    echo "║                                                           ║"
    echo "╠═══════════════════════════════════════════════════════════╣"
    echo "║  Commands:                                                ║"
    echo "║    ./scripts/stop.sh         - Stop all services          ║"
    echo "║    ./scripts/test-message.sh - Send test message          ║"
    echo "║                                                           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo -e "${YELLOW}Open http://localhost:3002 in your browser to enable push notifications${NC}"
    echo ""
}

# ===========================================
# Main
# ===========================================
main() {
    # Create logs directory
    mkdir -p logs
    
    check_prerequisites
    setup_environment
    start_services
    show_status
    
    echo -e "${GREEN}Startup complete!${NC}"
    echo ""
    echo "Press Ctrl+C or run ./scripts/stop.sh to stop all services"
    echo ""
    
    # Wait for user interrupt
    wait
}

main "$@"
