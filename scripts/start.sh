#!/bin/bash

# ===========================================
# Argus - Startup Script
# ===========================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Change to project directory
cd "$PROJECT_DIR"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║              Argus - Full Stack Startup Script            ║"
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
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker is not installed${NC}"
        echo "Install Docker from https://docs.docker.com/get-docker/"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Docker $(docker --version | cut -d' ' -f3 | tr -d ',')${NC}"
    
    # Check if dependencies are installed for main project
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}Installing Argus dependencies...${NC}"
        npm install
    fi
    echo -e "${GREEN}  ✓ Argus dependencies installed${NC}"
    
    # Check if dependencies are installed for Evolution API
    if [ ! -d "evolution-api/node_modules" ]; then
        echo -e "${YELLOW}Installing Evolution API dependencies...${NC}"
        cd evolution-api && npm install && cd ..
    fi
    echo -e "${GREEN}  ✓ Evolution API dependencies installed${NC}"
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
    mkdir -p data/db data/vectors logs
    echo -e "${GREEN}  ✓ Data directories created${NC}"
}

# ===========================================
# Start Docker services (PostgreSQL, Redis)
# ===========================================
start_docker_services() {
    echo ""
    echo -e "${YELLOW}Starting Docker services...${NC}"
    
    # Start PostgreSQL for Evolution API
    if docker ps -a --format '{{.Names}}' | grep -q "^evolution-postgres$"; then
        if docker ps --format '{{.Names}}' | grep -q "^evolution-postgres$"; then
            echo -e "${GREEN}  ✓ PostgreSQL already running${NC}"
        else
            echo -e "${BLUE}  Starting existing PostgreSQL container...${NC}"
            docker start evolution-postgres > /dev/null 2>&1
            echo -e "${GREEN}  ✓ PostgreSQL started${NC}"
        fi
    else
        echo -e "${BLUE}  Creating PostgreSQL container...${NC}"
        docker run -d \
            --name evolution-postgres \
            -e POSTGRES_USER=evolution \
            -e POSTGRES_PASSWORD=evolution123 \
            -e POSTGRES_DB=evolution \
            -p 5432:5432 \
            --restart unless-stopped \
            postgres:16-alpine > /dev/null 2>&1
        echo -e "${GREEN}  ✓ PostgreSQL created and started${NC}"
        # Wait for PostgreSQL to be ready
        echo -e "${YELLOW}  Waiting for PostgreSQL to be ready...${NC}"
        sleep 5
    fi
    
    # Start Redis
    if docker ps -a --format '{{.Names}}' | grep -q "^argus-redis$"; then
        if docker ps --format '{{.Names}}' | grep -q "^argus-redis$"; then
            echo -e "${GREEN}  ✓ Redis already running${NC}"
        else
            echo -e "${BLUE}  Starting existing Redis container...${NC}"
            docker start argus-redis > /dev/null 2>&1
            echo -e "${GREEN}  ✓ Redis started${NC}"
        fi
    else
        echo -e "${BLUE}  Creating Redis container...${NC}"
        docker run -d \
            --name argus-redis \
            -p 6379:6379 \
            --restart unless-stopped \
            redis:7-alpine > /dev/null 2>&1
        echo -e "${GREEN}  ✓ Redis created and started${NC}"
    fi
}

# ===========================================
# Start Node.js services
# ===========================================
start_services() {
    echo ""
    echo -e "${YELLOW}Starting Node.js services...${NC}"
    
    # Kill any existing processes on our ports
    echo -e "${YELLOW}  Cleaning up existing processes...${NC}"
    pkill -f "tsx.*src/index.ts" 2>/dev/null || true
    pkill -f "tsx.*src/orchestrator/index.ts" 2>/dev/null || true
    pkill -f "tsx.*webapp/server.ts" 2>/dev/null || true
    pkill -f "tsx.*evolution-api/src/main.ts" 2>/dev/null || true
    pkill -f "tsx watch.*evolution-api" 2>/dev/null || true
    sleep 1
    
    # Start main Argus service
    echo -e "${BLUE}  Starting Argus API on port 3000...${NC}"
    npm run dev > logs/rmd.log 2>&1 &
    RMD_PID=$!
    echo "  PID: $RMD_PID"
    
    # Start webapp for push notifications
    echo -e "${BLUE}  Starting Push Webapp on port 3002...${NC}"
    npx tsx webapp/server.ts > logs/webapp.log 2>&1 &
    WEBAPP_PID=$!
    echo "  PID: $WEBAPP_PID"
    
    # Start Evolution API
    echo -e "${BLUE}  Starting Evolution API on port 8080...${NC}"
    cd evolution-api
    npm run dev:server > ../logs/evolution.log 2>&1 &
    EVOLUTION_PID=$!
    cd ..
    echo "  PID: $EVOLUTION_PID"
    
    # Save PIDs to file for cleanup
    echo "$RMD_PID" > .pids
    echo "$WEBAPP_PID" >> .pids
    echo "$EVOLUTION_PID" >> .pids
    
    # Wait for services to start
    echo ""
    echo -e "${YELLOW}Waiting for services to start...${NC}"
    sleep 5
    
    # Check if services are running
    if kill -0 $RMD_PID 2>/dev/null; then
        echo -e "${GREEN}  ✓ Argus API started${NC}"
    else
        echo -e "${RED}  ✗ Argus API failed to start${NC}"
        echo "    Check logs/rmd.log for details"
    fi
    
    if kill -0 $WEBAPP_PID 2>/dev/null; then
        echo -e "${GREEN}  ✓ Push Webapp started${NC}"
    else
        echo -e "${RED}  ✗ Push Webapp failed to start${NC}"
        echo "    Check logs/webapp.log for details"
    fi
    
    if kill -0 $EVOLUTION_PID 2>/dev/null; then
        echo -e "${GREEN}  ✓ Evolution API started${NC}"
    else
        echo -e "${RED}  ✗ Evolution API failed to start${NC}"
        echo "    Check logs/evolution.log for details"
    fi
}

# ===========================================
# Show status and URLs
# ===========================================
show_status() {
    echo ""
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                    All Services Running                       ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║                                                               ║"
    echo "║  ${CYAN}Docker Services:${GREEN}                                            ║"
    echo "║    PostgreSQL:     localhost:5432 (evolution/evolution123)    ║"
    echo "║    Redis:          localhost:6379                             ║"
    echo "║                                                               ║"
    echo "║  ${CYAN}Node.js Services:${GREEN}                                           ║"
    echo "║    Argus API:      http://localhost:3000                      ║"
    echo "║    Push Webapp:    http://localhost:3002                      ║"
    echo "║    Evolution API:  http://localhost:8080                      ║"
    echo "║                                                               ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║  ${CYAN}Argus Endpoints:${GREEN}                                            ║"
    echo "║    POST /webhook/test       - Submit test message             ║"
    echo "║    POST /webhook/evolution  - Evolution API webhook           ║"
    echo "║    GET  /api/events         - List extracted events           ║"
    echo "║    GET  /api/metrics        - Pipeline metrics                ║"
    echo "║    GET  /api/learning/stats - Auto-learning stats             ║"
    echo "║                                                               ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║  ${CYAN}WhatsApp Login:${GREEN}                                             ║"
    echo "║    Run: ./scripts/whatsapp-login.sh                           ║"
    echo "║                                                               ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║  ${CYAN}Logs:${GREEN}                                                       ║"
    echo "║    tail -f logs/rmd.log        - Argus service logs           ║"
    echo "║    tail -f logs/webapp.log     - Webapp logs                  ║"
    echo "║    tail -f logs/evolution.log  - Evolution API logs           ║"
    echo "║                                                               ║"
    echo "╠═══════════════════════════════════════════════════════════════╣"
    echo "║  ${CYAN}Commands:${GREEN}                                                   ║"
    echo "║    ./scripts/stop.sh           - Stop all services            ║"
    echo "║    ./scripts/test-message.sh   - Send test message            ║"
    echo "║    ./scripts/whatsapp-login.sh - Connect WhatsApp             ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo -e "${YELLOW}Open http://localhost:3002 in your browser to enable push notifications${NC}"
    echo -e "${YELLOW}Run ./scripts/whatsapp-login.sh to connect WhatsApp${NC}"
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
    start_docker_services
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
