#!/bin/bash

# ===========================================
# Argus - Full Dev Startup
# Runs: PostgreSQL (Docker) + Evolution API + Argus API + Webapp
# ===========================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║     Argus - Full Development Setup                       ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ===========================================
# Check prerequisites
# ===========================================
check_prerequisites() {
    echo -e "${YELLOW}[1/6] Checking prerequisites...${NC}"
    
    # Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js not installed${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Node.js $(node -v)${NC}"
    
    # Docker (for PostgreSQL)
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}Error: Docker not installed${NC}"
        echo "Install Docker: https://docs.docker.com/get-docker/"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Docker installed${NC}"
    
    # Check if dependencies installed
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}  Installing RMD dependencies...${NC}"
        npm install
    fi
    echo -e "${GREEN}  ✓ RMD dependencies${NC}"
    
    # Check Evolution API
    if [ ! -d "evolution-api" ]; then
        echo -e "${YELLOW}  Cloning Evolution API...${NC}"
        git clone --depth 1 https://github.com/EvolutionAPI/evolution-api.git evolution-api
    fi
    
    if [ ! -d "evolution-api/node_modules" ]; then
        echo -e "${YELLOW}  Installing Evolution API dependencies...${NC}"
        cd evolution-api && npm install && cd ..
    fi
    echo -e "${GREEN}  ✓ Evolution API ready${NC}"
}

# ===========================================
# Setup environment files
# ===========================================
setup_environment() {
    echo -e "${YELLOW}[2/6] Setting up environment...${NC}"
    
    # Create RMD .env if not exists
    if [ ! -f ".env" ]; then
        cp .env.example .env
        echo -e "${YELLOW}  Created .env - please add OPENAI_API_KEY${NC}"
    fi
    
    # Generate VAPID keys if needed
    source .env 2>/dev/null || true
    if [ -z "$VAPID_PUBLIC_KEY" ] || [ -z "$VAPID_PRIVATE_KEY" ]; then
        echo -e "${YELLOW}  Generating VAPID keys...${NC}"
        VAPID_KEYS=$(npx web-push generate-vapid-keys --json 2>/dev/null)
        VAPID_PUBLIC=$(echo "$VAPID_KEYS" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
        VAPID_PRIVATE=$(echo "$VAPID_KEYS" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)
        
        if [ -n "$VAPID_PUBLIC" ]; then
            sed -i "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$VAPID_PUBLIC|" .env
            sed -i "s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=$VAPID_PRIVATE|" .env
        fi
    fi
    echo -e "${GREEN}  ✓ RMD environment ready${NC}"
    
    # Check Evolution API .env
    if [ ! -f "evolution-api/.env" ]; then
        echo -e "${RED}  ✗ evolution-api/.env not found!${NC}"
        echo -e "${YELLOW}    Copy the example file: cp evolution-api/.env.example evolution-api/.env${NC}"
        echo -e "${YELLOW}    And configure DATABASE_CONNECTION_URI and AUTHENTICATION_API_KEY${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ Evolution API environment ready${NC}"
    
    # Create directories
    mkdir -p data/db data/vectors logs logs/pipeline
    echo -e "${GREEN}  ✓ Directories created${NC}"
}

# ===========================================
# Start PostgreSQL
# ===========================================
start_postgres() {
    echo -e "${YELLOW}[3/6] Starting PostgreSQL...${NC}"
    
    # Check if postgres container already running
    if docker ps | grep -q rmd-postgres; then
        echo -e "${GREEN}  ✓ PostgreSQL already running${NC}"
        return 0
    fi
    
    # Check if container exists but stopped
    if docker ps -a | grep -q rmd-postgres; then
        docker start rmd-postgres > /dev/null 2>&1
        echo -e "${GREEN}  ✓ PostgreSQL started (existing container)${NC}"
        sleep 2
        return 0
    fi
    
    # Create new container
    docker run -d \
        --name rmd-postgres \
        -e POSTGRES_USER=evolution \
        -e POSTGRES_PASSWORD=evolution123 \
        -e POSTGRES_DB=evolution \
        -p 5432:5432 \
        -v rmd-postgres-data:/var/lib/postgresql/data \
        postgres:16-alpine > /dev/null 2>&1
    
    echo -e "${GREEN}  ✓ PostgreSQL started${NC}"
    
    # Wait for postgres to be ready
    echo -e "${YELLOW}  Waiting for PostgreSQL to be ready...${NC}"
    for i in {1..30}; do
        if docker exec rmd-postgres pg_isready -U evolution > /dev/null 2>&1; then
            echo -e "${GREEN}  ✓ PostgreSQL is ready${NC}"
            return 0
        fi
        sleep 1
    done
    
    echo -e "${RED}  PostgreSQL failed to start${NC}"
    exit 1
}

# ===========================================
# Setup Evolution API Database
# ===========================================
setup_evolution_db() {
    echo -e "${YELLOW}[4/6] Setting up Evolution API database...${NC}"
    
    cd evolution-api
    
    # Set database provider
    export DATABASE_PROVIDER=postgresql
    
    # Generate Prisma client
    echo -e "${BLUE}  Generating Prisma client...${NC}"
    npm run db:generate 2>&1 | grep -E "(Generated|Error)" || true
    
    # Run prisma migrations
    echo -e "${BLUE}  Running database migrations...${NC}"
    npm run db:deploy 2>&1 | grep -E "(applied|Error|Your database is now in sync)" || true
    
    cd ..
    echo -e "${GREEN}  ✓ Evolution API database ready${NC}"
}

# ===========================================
# Start all services
# ===========================================
start_services() {
    echo -e "${YELLOW}[5/6] Starting services...${NC}"
    
    # Kill any existing processes
    pkill -f "tsx.*src/index.ts" 2>/dev/null || true
    pkill -f "tsx.*webapp/server.ts" 2>/dev/null || true
    pkill -f "tsx.*evolution-api" 2>/dev/null || true
    sleep 1
    
    # Start Evolution API (port 8080)
    echo -e "${BLUE}  Starting Evolution API on port 8080...${NC}"
    cd evolution-api
    npm run start > ../logs/evolution.log 2>&1 &
    EVOLUTION_PID=$!
    cd ..
    echo "  PID: $EVOLUTION_PID"
    
    # Start Argus API (port 3000)
    echo -e "${BLUE}  Starting Argus API on port 3000...${NC}"
    npx tsx src/index.ts > logs/rmd.log 2>&1 &
    RMD_PID=$!
    echo "  PID: $RMD_PID"
    
    # Start Push Webapp (port 3002)
    echo -e "${BLUE}  Starting Push Webapp on port 3002...${NC}"
    npx tsx webapp/server.ts > logs/webapp.log 2>&1 &
    WEBAPP_PID=$!
    echo "  PID: $WEBAPP_PID"
    
    # Save PIDs
    echo "$EVOLUTION_PID" > .pids
    echo "$RMD_PID" >> .pids
    echo "$WEBAPP_PID" >> .pids
    
    # Wait for services
    echo -e "${YELLOW}  Waiting for services to start...${NC}"
    sleep 5
    
    # Verify services
    for port in 8080 3000 3002; do
        if curl -s "http://localhost:$port" > /dev/null 2>&1 || curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            echo -e "${GREEN}  ✓ Port $port is responding${NC}"
        else
            echo -e "${YELLOW}  ⚠ Port $port not responding yet (check logs)${NC}"
        fi
    done
}

# ===========================================
# Show status
# ===========================================
show_status() {
    echo -e "${YELLOW}[6/6] Setup complete!${NC}"
    echo ""
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════════════╗"
    echo "║                    All Services Running                           ║"
    echo "╠═══════════════════════════════════════════════════════════════════╣"
    echo "║                                                                   ║"
    echo "║  Evolution API:  http://localhost:8080                            ║"
    echo "║  Argus API:      http://localhost:3000                            ║"
    echo "║  Dashboard:      http://localhost:3002                            ║"
    echo "║                                                                   ║"
    echo "╠═══════════════════════════════════════════════════════════════════╣"
    echo "║  Next Steps:                                                      ║"
    echo "║                                                                   ║"
    echo "║  1. Login to WhatsApp:                                            ║"
    echo "║     ./scripts/whatsapp-login.sh                                   ║"
    echo "║                                                                   ║"
    echo "║  2. Open Dashboard & Enable Push Notifications:                   ║"
    echo "║     Open http://localhost:3002                                    ║"
    echo "║                                                                   ║"
    echo "║  3. Test a message:                                               ║"
    echo "║     ./scripts/test-message.sh \"Meeting at 3pm\"                    ║"
    echo "║                                                                   ║"
    echo "╠═══════════════════════════════════════════════════════════════════╣"
    echo "║  Logs:                                                            ║"
    echo "║    tail -f logs/rmd.log              # Main service               ║"
    echo "║    cat logs/pipeline/07-summary.log  # Pipeline summary           ║"
    echo "║    cat logs/pipeline/00-errors.log   # Errors                     ║"
    echo "║                                                                   ║"
    echo "║  Stop all: ./scripts/stop-all.sh                                  ║"
    echo "╚═══════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    
    # Show Evolution API key
    source evolution-api/.env 2>/dev/null || true
    echo -e "${CYAN}Evolution API Key: ${AUTHENTICATION_API_KEY}${NC}"
    echo ""
}

# ===========================================
# Main
# ===========================================
main() {
    check_prerequisites
    setup_environment
    start_postgres
    setup_evolution_db
    start_services
    show_status
}

main "$@"
