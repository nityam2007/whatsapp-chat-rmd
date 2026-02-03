#!/bin/bash

# ===========================================
# Argus - Production-Ready Stop Script
# ===========================================
# Features:
# - Graceful service shutdown
# - Optional Docker cleanup
# - PID-based process management
# - Status verification
# ===========================================

set -u

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Icons
CHECK="${GREEN}✓${NC}"
CROSS="${RED}✗${NC}"
ARROW="${CYAN}→${NC}"
WARN="${YELLOW}⚠${NC}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
ARGUS_PORT="${PORT:-3000}"
WEBAPP_PORT="${WEBAPP_PORT:-3002}"
EVOLUTION_PORT="${EVOLUTION_PORT:-8080}"

# Counters
STOPPED=0
ALREADY_STOPPED=0

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
}

log_warn() {
    echo -e "  ${WARN} ${YELLOW}$1${NC}"
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
    else
        (echo >/dev/tcp/localhost/"$port") &>/dev/null
    fi
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

# Kill process on port with grace
kill_port() {
    local port=$1
    local name=$2
    
    if port_in_use "$port"; then
        local pid
        pid=$(get_process_on_port "$port")
        if [ -n "$pid" ]; then
            log_step "Stopping $name (PID: $pid)..."
            # Try graceful shutdown first
            kill "$pid" 2>/dev/null
            
            # Wait up to 5 seconds for graceful shutdown
            local count=0
            while [ $count -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
                sleep 0.5
                count=$((count + 1))
            done
            
            # Force kill if still running
            if kill -0 "$pid" 2>/dev/null; then
                log_warn "Forcing kill..."
                kill -9 "$pid" 2>/dev/null
                sleep 1
            fi
            
            if ! kill -0 "$pid" 2>/dev/null; then
                log_success "$name stopped"
                ((STOPPED++))
                return 0
            else
                log_error "Failed to stop $name"
                return 1
            fi
        fi
    else
        log_success "$name already stopped"
        ((ALREADY_STOPPED++))
    fi
}

# Check Docker container status
docker_container_running() {
    local name=$1
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"
}

# ===========================================
# Banner
# ===========================================
show_banner() {
    echo -e "${CYAN}"
    echo "  Argus - Stop Services"
    echo -e "${NC}"
}

# ===========================================
# Stop Node.js Services
# ===========================================
stop_nodejs_services() {
    log_header "Stopping Node.js Services"
    
    # Stop from PID file first
    if [ -f "$PROJECT_DIR/.pids" ]; then
        while read -r pid; do
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                log_step "Stopping process $pid from PID file..."
                kill "$pid" 2>/dev/null
            fi
        done < "$PROJECT_DIR/.pids"
        rm -f "$PROJECT_DIR/.pids"
        sleep 1
    fi
    
    # Kill by port (backup method)
    echo -e "  ${BOLD}Argus API (port $ARGUS_PORT)${NC}"
    kill_port "$ARGUS_PORT" "Argus API"
    
    echo ""
    echo -e "  ${BOLD}Push Webapp (port $WEBAPP_PORT)${NC}"
    kill_port "$WEBAPP_PORT" "Push Webapp"
    
    echo ""
    echo -e "  ${BOLD}Evolution API (port $EVOLUTION_PORT)${NC}"
    kill_port "$EVOLUTION_PORT" "Evolution API"
    
    # Kill any remaining tsx processes related to this project
    pkill -f "tsx.*$PROJECT_DIR" 2>/dev/null || true
    pkill -f "tsx.*src/index.ts" 2>/dev/null || true
    pkill -f "tsx.*webapp/server.ts" 2>/dev/null || true
    pkill -f "evolution-api.*npm" 2>/dev/null || true
}

# ===========================================
# Stop Docker Services
# ===========================================
stop_docker_services() {
    local stop_docker=${1:-false}
    
    if [ "$stop_docker" = true ]; then
        log_header "Stopping Docker Services"
        
        echo -e "  ${BOLD}PostgreSQL${NC}"
        if docker_container_running "evolution-postgres"; then
            log_step "Stopping PostgreSQL..."
            docker stop evolution-postgres > /dev/null 2>&1
            log_success "PostgreSQL stopped"
            ((STOPPED++))
        else
            log_success "PostgreSQL already stopped"
            ((ALREADY_STOPPED++))
        fi
        
        echo ""
        echo -e "  ${BOLD}Redis${NC}"
        if docker_container_running "argus-redis"; then
            log_step "Stopping Redis..."
            docker stop argus-redis > /dev/null 2>&1
            log_success "Redis stopped"
            ((STOPPED++))
        else
            log_success "Redis already stopped"
            ((ALREADY_STOPPED++))
        fi
    else
        echo ""
        echo -e "${YELLOW}Docker services (PostgreSQL, Redis) are still running.${NC}"
        echo -e "To stop them, run: ${CYAN}./scripts/stop.sh --docker${NC}"
    fi
}

# ===========================================
# Show Summary
# ===========================================
show_summary() {
    echo ""
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${GREEN}Stopped: $STOPPED${NC}  |  ${CYAN}Already stopped: $ALREADY_STOPPED${NC}"
    echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# ===========================================
# Help
# ===========================================
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --docker, -d    Also stop Docker services (PostgreSQL, Redis)"
    echo "  --all, -a       Stop everything including Docker services"
    echo "  --force, -f     Force kill all processes immediately"
    echo "  --help, -h      Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0              Stop Node.js services only"
    echo "  $0 --docker     Stop all services including Docker"
    echo "  $0 --force      Force kill all processes"
    echo ""
}

# ===========================================
# Main
# ===========================================
main() {
    local stop_docker=false
    local force_kill=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --docker|-d|--all|-a)
                stop_docker=true
                shift
                ;;
            --force|-f)
                force_kill=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
    
    show_banner
    
    if [ "$force_kill" = true ]; then
        log_header "Force Killing All Services"
        
        # Kill all related processes
        pkill -9 -f "tsx.*src/index.ts" 2>/dev/null || true
        pkill -9 -f "tsx.*webapp/server.ts" 2>/dev/null || true
        pkill -9 -f "evolution-api" 2>/dev/null || true
        pkill -9 -f "tsx.*$PROJECT_DIR" 2>/dev/null || true
        
        # Clear PID file
        rm -f "$PROJECT_DIR/.pids"
        
        log_success "All processes force killed"
        
        if [ "$stop_docker" = true ]; then
            docker stop evolution-postgres argus-redis 2>/dev/null || true
            log_success "Docker containers stopped"
        fi
    else
        stop_nodejs_services
        stop_docker_services "$stop_docker"
    fi
    
    show_summary
    
    echo -e "${GREEN}All services stopped.${NC}"
    echo -e "Run ${CYAN}./scripts/start.sh${NC} to start services again."
    echo ""
}

main "$@"
