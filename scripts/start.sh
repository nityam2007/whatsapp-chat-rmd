#!/bin/bash

# ===========================================
# Argus - Production-Ready Startup Script
# ===========================================
# Features:
# - Parallel service startup
# - Skip already running services
# - Comprehensive error handling
# - Health check verification
# - Colored status output
# - Graceful failure handling
# ===========================================

# Exit on undefined variables, but handle errors gracefully
set -u

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Icons
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}→${NC}"
WARN="${YELLOW}⚠${NC}"
INFO="${BLUE}ℹ${NC}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
ARGUS_PORT="${PORT:-3000}"
WEBAPP_PORT="${WEBAPP_PORT:-3002}"
EVOLUTION_PORT="${EVOLUTION_PORT:-8080}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"

# Timeouts
HEALTH_CHECK_TIMEOUT=30
HEALTH_CHECK_INTERVAL=2

# State tracking
ERRORS=0
WARNINGS=0
SERVICES_STARTED=0
SERVICES_SKIPPED=0

# Change to project directory
cd "$PROJECT_DIR"

# ===========================================
# Utility Functions
# ===========================================

log_header() {
    echo ""
    echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}${BLUE}  $1${NC}"
    echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

log_success() {
    echo -e "  ${CHECK} $1"
}

log_error() {
    echo -e "  ${CROSS} ${RED}$1${NC}"
    ((ERRORS++))
}

log_warn() {
    echo -e "  ${WARN} ${YELLOW}$1${NC}"
    ((WARNINGS++))
}

log_info() {
    echo -e "  ${INFO} $1"
}

log_step() {
    echo -e "  ${ARROW} $1"
}

# Check if a port is in use
port_in_use() {
    local port=$1
    if command -v lsof &> /dev/null; then
        lsof -i :"$port" &> /dev/null
    elif command -v ss &> /dev/null; then
        ss -tuln | grep -q ":$port "
    elif command -v netstat &> /dev/null; then
        netstat -tuln | grep -q ":$port "
    else
        # Fallback: try to connect
        (echo >/dev/tcp/localhost/"$port") &>/dev/null
    fi
}

# Check if a URL is responding
check_url() {
    local url=$1
    local timeout=${2:-5}
    curl -s -o /dev/null -w "%{http_code}" --connect-timeout "$timeout" "$url" 2>/dev/null
}

# Wait for a service to be healthy
wait_for_health() {
    local name=$1
    local url=$2
    local timeout=${3:-$HEALTH_CHECK_TIMEOUT}
    local elapsed=0
    
    while [ $elapsed -lt $timeout ]; do
        local status
        status=$(check_url "$url" 2)
        if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
            return 0
        fi
        sleep $HEALTH_CHECK_INTERVAL
        elapsed=$((elapsed + HEALTH_CHECK_INTERVAL))
    done
    return 1
}

# Check Docker container status
docker_container_running() {
    local name=$1
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"
}

# Check Docker container exists
docker_container_exists() {
    local name=$1
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"
}

# Get process listening on port
get_process_on_port() {
    local port=$1
    if command -v lsof &> /dev/null; then
        lsof -i :"$port" -t 2>/dev/null | head -1
    else
        echo ""
    fi
}

# ===========================================
# Banner
# ===========================================
show_banner() {
    echo -e "${CYAN}"
    cat << 'EOF'
    ___                           
   /   |  _________ ___  _______  
  / /| | / ___/ __ `/ / / / ___/  
 / ___ |/ /  / /_/ / /_/ (__  )   
/_/  |_/_/   \__, /\__,_/____/    
            /____/                
EOF
    echo -e "${NC}"
    echo -e "${BOLD}${MAGENTA}  WhatsApp AI Event Extraction System${NC}"
    echo -e "${CYAN}  v0.5.0 - Auto-Learning Edition${NC}"
    echo ""
}

# ===========================================
# Check Prerequisites
# ===========================================
check_prerequisites() {
    log_header "Checking Prerequisites"
    local has_errors=false
    
    # Check Node.js
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 20 ]; then
            log_success "Node.js $(node -v)"
        else
            log_error "Node.js 20+ required (found v$NODE_VERSION)"
            has_errors=true
        fi
    else
        log_error "Node.js is not installed"
        echo "       Install from: https://nodejs.org"
        has_errors=true
    fi
    
    # Check npm
    if command -v npm &> /dev/null; then
        log_success "npm $(npm -v)"
    else
        log_error "npm is not installed"
        has_errors=true
    fi
    
    # Check Docker
    if command -v docker &> /dev/null; then
        if docker info &> /dev/null; then
            log_success "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
        else
            log_error "Docker is not running"
            echo "       Start Docker and try again"
            has_errors=true
        fi
    else
        log_error "Docker is not installed"
        echo "       Install from: https://docs.docker.com/get-docker/"
        has_errors=true
    fi
    
    # Check curl (needed for health checks)
    if command -v curl &> /dev/null; then
        log_success "curl available"
    else
        log_warn "curl not found - health checks may fail"
    fi
    
    if [ "$has_errors" = true ]; then
        echo ""
        log_error "Prerequisites check failed. Please fix the issues above."
        exit 1
    fi
}

# ===========================================
# Setup Dependencies
# ===========================================
setup_dependencies() {
    log_header "Checking Dependencies"
    
    # Main project dependencies
    if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
        log_success "Argus dependencies installed"
    else
        log_step "Installing Argus dependencies..."
        if npm install --silent 2>/dev/null; then
            log_success "Argus dependencies installed"
        else
            log_error "Failed to install Argus dependencies"
            exit 1
        fi
    fi
    
    # Evolution API dependencies
    if [ -d "evolution-api" ]; then
        if [ -d "evolution-api/node_modules" ]; then
            log_success "Evolution API dependencies installed"
        else
            log_step "Installing Evolution API dependencies..."
            if (cd evolution-api && npm install --silent 2>/dev/null); then
                log_success "Evolution API dependencies installed"
            else
                log_error "Failed to install Evolution API dependencies"
                exit 1
            fi
        fi
    else
        log_warn "Evolution API directory not found (optional)"
    fi
}

# ===========================================
# Setup Environment
# ===========================================
setup_environment() {
    log_header "Setting Up Environment"
    
    # Create .env if needed
    if [ ! -f ".env" ]; then
        if [ -f ".env.example" ]; then
            cp .env.example .env
            log_warn "Created .env from .env.example - please configure it"
        else
            log_error ".env file not found and no .env.example to copy"
            exit 1
        fi
    else
        log_success ".env file exists"
    fi
    
    # Load environment variables
    if [ -f ".env" ]; then
        set -a
        source .env 2>/dev/null || true
        set +a
    fi
    
    # Check OpenAI API Key
    if [ -n "${OPENAI_API_KEY:-}" ] && [ "$OPENAI_API_KEY" != "your-api-key-here" ]; then
        log_success "OpenAI API key configured"
    else
        log_warn "OpenAI API key not set - AI features will not work"
    fi
    
    # Generate VAPID keys if needed
    if [ -z "${VAPID_PUBLIC_KEY:-}" ] || [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
        log_step "Generating VAPID keys for push notifications..."
        VAPID_KEYS=$(npx web-push generate-vapid-keys --json 2>/dev/null || echo "")
        if [ -n "$VAPID_KEYS" ]; then
            VAPID_PUBLIC=$(echo "$VAPID_KEYS" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
            VAPID_PRIVATE=$(echo "$VAPID_KEYS" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)
            if [ -n "$VAPID_PUBLIC" ] && [ -n "$VAPID_PRIVATE" ]; then
                # Update .env file
                if grep -q "^VAPID_PUBLIC_KEY=" .env; then
                    sed -i "s|^VAPID_PUBLIC_KEY=.*|VAPID_PUBLIC_KEY=$VAPID_PUBLIC|" .env
                else
                    echo "VAPID_PUBLIC_KEY=$VAPID_PUBLIC" >> .env
                fi
                if grep -q "^VAPID_PRIVATE_KEY=" .env; then
                    sed -i "s|^VAPID_PRIVATE_KEY=.*|VAPID_PRIVATE_KEY=$VAPID_PRIVATE|" .env
                else
                    echo "VAPID_PRIVATE_KEY=$VAPID_PRIVATE" >> .env
                fi
                export VAPID_PUBLIC_KEY="$VAPID_PUBLIC"
                export VAPID_PRIVATE_KEY="$VAPID_PRIVATE"
                log_success "VAPID keys generated"
            fi
        else
            log_warn "Could not generate VAPID keys - push notifications may not work"
        fi
    else
        log_success "VAPID keys configured"
    fi
    
    # Create directories
    mkdir -p data/db data/vectors logs
    log_success "Data directories ready"
    
    # Setup Evolution API environment
    if [ -d "evolution-api" ]; then
        if [ ! -f "evolution-api/.env" ]; then
            if [ -f "evolution-api/.env.example.local" ]; then
                cp evolution-api/.env.example.local evolution-api/.env
                log_success "Evolution API .env created from .env.example.local"
            elif [ -f "evolution-api/.env.example" ]; then
                cp evolution-api/.env.example evolution-api/.env
                log_warn "Evolution API .env created from .env.example - may need configuration"
            fi
        else
            log_success "Evolution API .env exists"
        fi
    fi
}

# ===========================================
# Setup Evolution API Database
# ===========================================
setup_evolution_database() {
    if [ ! -d "evolution-api" ]; then
        return 0
    fi
    
    log_header "Evolution API Database"
    
    # Check if Prisma client has been properly generated by looking for the query engine
    # The directory may exist from npm install but without the actual generated client
    local prisma_generated=false
    if ls evolution-api/node_modules/.prisma/client/libquery_engine* &>/dev/null || \
       ls evolution-api/node_modules/.prisma/client/query-engine* &>/dev/null; then
        prisma_generated=true
    fi
    
    if [ "$prisma_generated" = true ]; then
        log_success "Prisma client already generated"
    else
        log_step "Generating Prisma client..."
        if (cd evolution-api && DATABASE_PROVIDER=postgresql npm run db:generate 2>&1 | tail -5); then
            log_success "Prisma client generated"
        else
            log_warn "Failed to generate Prisma client - will retry after PostgreSQL starts"
        fi
    fi
    
    # Check if we need to run migrations
    # We'll run deploy which is idempotent (safe to run multiple times)
    log_step "Running database migrations..."
    if (cd evolution-api && DATABASE_PROVIDER=postgresql npm run db:deploy 2>/dev/null); then
        log_success "Database migrations applied"
    else
        log_warn "Database migrations may have failed - check logs/evolution.log"
    fi
}

# ===========================================
# Start Docker Services
# ===========================================
start_docker_services() {
    log_header "Docker Services"
    
    # PostgreSQL
    echo -e "  ${BOLD}PostgreSQL (port $POSTGRES_PORT)${NC}"
    if docker_container_running "evolution-postgres"; then
        log_success "Already running"
        ((SERVICES_SKIPPED++))
    elif docker_container_exists "evolution-postgres"; then
        log_step "Starting existing container..."
        if docker start evolution-postgres > /dev/null 2>&1; then
            log_success "Started"
            ((SERVICES_STARTED++))
        else
            log_error "Failed to start PostgreSQL container"
        fi
    else
        log_step "Creating new container..."
        if docker run -d \
            --name evolution-postgres \
            -e POSTGRES_USER=evolution \
            -e POSTGRES_PASSWORD=evolution123 \
            -e POSTGRES_DB=evolution \
            -p $POSTGRES_PORT:5432 \
            --restart unless-stopped \
            --health-cmd="pg_isready -U evolution" \
            --health-interval=10s \
            --health-timeout=5s \
            --health-retries=5 \
            postgres:16-alpine > /dev/null 2>&1; then
            log_success "Created and started"
            log_step "Waiting for PostgreSQL to be ready..."
            sleep 5
            ((SERVICES_STARTED++))
        else
            log_error "Failed to create PostgreSQL container"
        fi
    fi
    
    # Redis
    echo ""
    echo -e "  ${BOLD}Redis (port $REDIS_PORT)${NC}"
    if docker_container_running "argus-redis"; then
        log_success "Already running"
        ((SERVICES_SKIPPED++))
    elif docker_container_exists "argus-redis"; then
        log_step "Starting existing container..."
        if docker start argus-redis > /dev/null 2>&1; then
            log_success "Started"
            ((SERVICES_STARTED++))
        else
            log_error "Failed to start Redis container"
        fi
    else
        log_step "Creating new container..."
        if docker run -d \
            --name argus-redis \
            -p $REDIS_PORT:6379 \
            --restart unless-stopped \
            --health-cmd="redis-cli ping" \
            --health-interval=10s \
            --health-timeout=5s \
            --health-retries=5 \
            redis:7-alpine > /dev/null 2>&1; then
            log_success "Created and started"
            ((SERVICES_STARTED++))
        else
            log_error "Failed to create Redis container"
        fi
    fi
}

# ===========================================
# Start Node.js Services (Parallel)
# ===========================================
start_nodejs_services() {
    log_header "Node.js Services"
    
    local pids_file="$PROJECT_DIR/.pids"
    > "$pids_file"  # Clear PIDs file
    
    # Arrays to track parallel operations
    declare -a service_names=()
    declare -a service_pids=()
    declare -a service_ports=()
    declare -a service_urls=()
    declare -a service_logfiles=()
    declare -a service_started=()
    
    # --- Argus API ---
    echo -e "  ${BOLD}Argus API (port $ARGUS_PORT)${NC}"
    if port_in_use "$ARGUS_PORT"; then
        local existing_pid
        existing_pid=$(get_process_on_port "$ARGUS_PORT")
        # Check if it's actually Argus running
        if curl -s "http://localhost:$ARGUS_PORT/" 2>/dev/null | grep -q "Argus"; then
            log_success "Already running (PID: $existing_pid)"
            ((SERVICES_SKIPPED++))
            service_started+=("skipped")
        else
            log_warn "Port $ARGUS_PORT in use by another process (PID: $existing_pid)"
            log_step "Attempting to free port..."
            kill "$existing_pid" 2>/dev/null || true
            sleep 1
            service_started+=("pending")
        fi
    else
        service_started+=("pending")
    fi
    
    if [ "${service_started[0]:-pending}" = "pending" ]; then
        log_step "Starting Argus API..."
        nohup npx tsx src/index.ts > logs/rmd.log 2>&1 &
        local argus_pid=$!
        echo "$argus_pid" >> "$pids_file"
        service_names+=("Argus API")
        service_pids+=("$argus_pid")
        service_ports+=("$ARGUS_PORT")
        service_urls+=("http://localhost:$ARGUS_PORT/")
        service_logfiles+=("logs/rmd.log")
    fi
    
    # --- Push Webapp ---
    echo ""
    echo -e "  ${BOLD}Push Webapp (port $WEBAPP_PORT)${NC}"
    if port_in_use "$WEBAPP_PORT"; then
        if curl -s "http://localhost:$WEBAPP_PORT/health" 2>/dev/null | grep -q "ok"; then
            log_success "Already running"
            ((SERVICES_SKIPPED++))
        else
            local existing_pid
            existing_pid=$(get_process_on_port "$WEBAPP_PORT")
            log_warn "Port $WEBAPP_PORT in use (PID: $existing_pid)"
            log_step "Attempting to free port..."
            kill "$existing_pid" 2>/dev/null || true
            sleep 1
            log_step "Starting Push Webapp..."
            nohup npx tsx webapp/server.ts > logs/webapp.log 2>&1 &
            local webapp_pid=$!
            echo "$webapp_pid" >> "$pids_file"
            service_names+=("Push Webapp")
            service_pids+=("$webapp_pid")
            service_ports+=("$WEBAPP_PORT")
            service_urls+=("http://localhost:$WEBAPP_PORT/health")
            service_logfiles+=("logs/webapp.log")
        fi
    else
        log_step "Starting Push Webapp..."
        nohup npx tsx webapp/server.ts > logs/webapp.log 2>&1 &
        local webapp_pid=$!
        echo "$webapp_pid" >> "$pids_file"
        service_names+=("Push Webapp")
        service_pids+=("$webapp_pid")
        service_ports+=("$WEBAPP_PORT")
        service_urls+=("http://localhost:$WEBAPP_PORT/health")
        service_logfiles+=("logs/webapp.log")
    fi
    
    # --- Evolution API ---
    echo ""
    echo -e "  ${BOLD}Evolution API (port $EVOLUTION_PORT)${NC}"
    if [ ! -d "evolution-api" ]; then
        log_warn "Evolution API directory not found - skipping"
    elif port_in_use "$EVOLUTION_PORT"; then
        if curl -s "http://localhost:$EVOLUTION_PORT/" 2>/dev/null | grep -q "Evolution"; then
            log_success "Already running"
            ((SERVICES_SKIPPED++))
        else
            local existing_pid
            existing_pid=$(get_process_on_port "$EVOLUTION_PORT")
            log_warn "Port $EVOLUTION_PORT in use (PID: $existing_pid)"
            log_step "Attempting to free port..."
            kill "$existing_pid" 2>/dev/null || true
            sleep 1
            log_step "Starting Evolution API..."
            (cd evolution-api && nohup npm run start > ../logs/evolution.log 2>&1 &)
            local evolution_pid=$!
            echo "$evolution_pid" >> "$pids_file"
            service_names+=("Evolution API")
            service_pids+=("$evolution_pid")
            service_ports+=("$EVOLUTION_PORT")
            service_urls+=("http://localhost:$EVOLUTION_PORT/")
            service_logfiles+=("logs/evolution.log")
        fi
    else
        log_step "Starting Evolution API..."
        (cd evolution-api && nohup npm run start > ../logs/evolution.log 2>&1 &)
        local evolution_pid=$!
        echo "$evolution_pid" >> "$pids_file"
        service_names+=("Evolution API")
        service_pids+=("$evolution_pid")
        service_ports+=("$EVOLUTION_PORT")
        service_urls+=("http://localhost:$EVOLUTION_PORT/")
        service_logfiles+=("logs/evolution.log")
    fi
    
    # --- Wait for all services to be healthy ---
    if [ ${#service_names[@]} -gt 0 ]; then
        echo ""
        log_header "Verifying Service Health"
        
        for i in "${!service_names[@]}"; do
            local name="${service_names[$i]}"
            local pid="${service_pids[$i]}"
            local url="${service_urls[$i]}"
            local logfile="${service_logfiles[$i]}"
            
            echo -e "  ${BOLD}$name${NC}"
            
            # First check if process is still running
            if ! kill -0 "$pid" 2>/dev/null; then
                log_error "Process died immediately"
                echo "       Check $logfile for details"
                continue
            fi
            
            # Wait for health check
            log_step "Waiting for health check..."
            if wait_for_health "$name" "$url" $HEALTH_CHECK_TIMEOUT; then
                log_success "Healthy (PID: $pid)"
                ((SERVICES_STARTED++))
            else
                # Check if process is still running
                if kill -0 "$pid" 2>/dev/null; then
                    log_warn "Health check timed out but process is running"
                    echo "       Service may still be starting - check $logfile"
                else
                    log_error "Process died during startup"
                    echo "       Check $logfile for details"
                    # Show last few lines of log
                    if [ -f "$logfile" ]; then
                        echo ""
                        echo -e "       ${YELLOW}Last 5 lines of $logfile:${NC}"
                        tail -5 "$logfile" | sed 's/^/       /'
                    fi
                fi
            fi
        done
    fi
}

# ===========================================
# Show Final Status
# ===========================================
show_status() {
    log_header "Service Status"
    
    # Docker services status
    echo -e "  ${BOLD}Docker Services:${NC}"
    
    if docker_container_running "evolution-postgres"; then
        echo -e "    ${CHECK} PostgreSQL       ${GREEN}running${NC}   localhost:$POSTGRES_PORT"
    else
        echo -e "    ${CROSS} PostgreSQL       ${RED}stopped${NC}"
    fi
    
    if docker_container_running "argus-redis"; then
        echo -e "    ${CHECK} Redis            ${GREEN}running${NC}   localhost:$REDIS_PORT"
    else
        echo -e "    ${CROSS} Redis            ${RED}stopped${NC}"
    fi
    
    echo ""
    echo -e "  ${BOLD}Node.js Services:${NC}"
    
    # Check Argus API
    local argus_status
    argus_status=$(check_url "http://localhost:$ARGUS_PORT/" 2)
    if [ "$argus_status" = "200" ]; then
        echo -e "    ${CHECK} Argus API        ${GREEN}running${NC}   http://localhost:$ARGUS_PORT"
    else
        echo -e "    ${CROSS} Argus API        ${RED}stopped${NC}   (port $ARGUS_PORT)"
    fi
    
    # Check Webapp
    local webapp_status
    webapp_status=$(check_url "http://localhost:$WEBAPP_PORT/health" 2)
    if [ "$webapp_status" = "200" ]; then
        echo -e "    ${CHECK} Push Webapp      ${GREEN}running${NC}   http://localhost:$WEBAPP_PORT"
    else
        echo -e "    ${CROSS} Push Webapp      ${RED}stopped${NC}   (port $WEBAPP_PORT)"
    fi
    
    # Check Evolution API
    local evolution_status
    evolution_status=$(check_url "http://localhost:$EVOLUTION_PORT/" 2)
    if [ "$evolution_status" = "200" ]; then
        echo -e "    ${CHECK} Evolution API    ${GREEN}running${NC}   http://localhost:$EVOLUTION_PORT"
    else
        echo -e "    ${CROSS} Evolution API    ${RED}stopped${NC}   (port $EVOLUTION_PORT)"
    fi
    
    # Summary
    echo ""
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${GREEN}Started: $SERVICES_STARTED${NC}  |  ${CYAN}Skipped: $SERVICES_SKIPPED${NC}  |  ${RED}Errors: $ERRORS${NC}  |  ${YELLOW}Warnings: $WARNINGS${NC}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ===========================================
# Show Quick Reference
# ===========================================
show_quick_reference() {
    echo ""
    echo -e "${BOLD}${CYAN}Quick Reference:${NC}"
    echo ""
    echo -e "  ${BOLD}Web Interfaces:${NC}"
    echo -e "    Dashboard:        ${CYAN}http://localhost:$WEBAPP_PORT${NC}"
    echo -e "    Evolution Manager:${CYAN}http://localhost:$EVOLUTION_PORT/manager${NC}"
    echo ""
    echo -e "  ${BOLD}Commands:${NC}"
    echo -e "    WhatsApp Login:   ${YELLOW}./scripts/whatsapp-login.sh${NC}"
    echo -e "    Test Message:     ${YELLOW}./scripts/test-message.sh \"Your message\"${NC}"
    echo -e "    Stop Services:    ${YELLOW}./scripts/stop.sh${NC}"
    echo ""
    echo -e "  ${BOLD}Logs:${NC}"
    echo -e "    Argus API:        ${YELLOW}tail -f logs/rmd.log${NC}"
    echo -e "    Push Webapp:      ${YELLOW}tail -f logs/webapp.log${NC}"
    echo -e "    Evolution API:    ${YELLOW}tail -f logs/evolution.log${NC}"
    echo ""
}

# ===========================================
# Cleanup on exit
# ===========================================
cleanup() {
    echo ""
    echo -e "${YELLOW}Received interrupt signal. Services will continue running in background.${NC}"
    echo -e "Run ${CYAN}./scripts/stop.sh${NC} to stop all services."
    exit 0
}

trap cleanup SIGINT SIGTERM

# ===========================================
# Main
# ===========================================
main() {
    local start_time
    start_time=$(date +%s)
    
    show_banner
    check_prerequisites
    setup_dependencies
    setup_environment
    start_docker_services
    setup_evolution_database
    start_nodejs_services
    show_status
    show_quick_reference
    
    local end_time
    end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    echo -e "${GREEN}${BOLD}Startup completed in ${duration}s${NC}"
    echo ""
    
    if [ $ERRORS -gt 0 ]; then
        echo -e "${RED}Some services failed to start. Check the logs for details.${NC}"
        exit 1
    fi
    
    echo -e "${CYAN}Press Ctrl+C to exit (services will continue running)${NC}"
    echo ""
    
    # Keep script running to show it's active, but services run independently
    while true; do
        sleep 60
    done
}

# Run main function
main "$@"
