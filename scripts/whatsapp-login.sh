#!/bin/bash

# ===========================================
# WhatsApp Login Script (Evolution API)
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

# Load environment
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs 2>/dev/null) || true
fi

# Load Evolution API env
if [ -f "evolution-api/.env" ]; then
    export $(grep -v '^#' evolution-api/.env | xargs 2>/dev/null) || true
fi

EVOLUTION_URL="${EVOLUTION_API_URL:-http://localhost:8080}"
EVOLUTION_KEY="${AUTHENTICATION_API_KEY:-your_super_secret_key_here_12345}"
INSTANCE_NAME="${1:-whatsapp-rmd}"
RMD_WEBHOOK_URL="${2:-http://localhost:3000/webhook/evolution}"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║            WhatsApp Login (Evolution API)                 ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo "Evolution URL: $EVOLUTION_URL"
echo "Instance: $INSTANCE_NAME"
echo ""

# ===========================================
# Check Evolution API is running
# ===========================================
check_evolution() {
    echo -e "${YELLOW}Checking Evolution API...${NC}"
    
    # Try to connect
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$EVOLUTION_URL" 2>/dev/null || echo "000")
    
    if [ "$RESPONSE" = "000" ]; then
        echo -e "${RED}Error: Evolution API is not running at $EVOLUTION_URL${NC}"
        echo ""
        echo "Start all services first:"
        echo -e "${CYAN}  ./scripts/start-all.sh${NC}"
        echo ""
        exit 1
    fi
    
    echo -e "${GREEN}  ✓ Evolution API is running (HTTP $RESPONSE)${NC}"
}

# ===========================================
# Create WhatsApp Instance
# ===========================================
create_instance() {
    echo -e "${YELLOW}Creating/checking WhatsApp instance: $INSTANCE_NAME${NC}"
    
    # Check if instance exists
    INSTANCES=$(curl -s -X GET "$EVOLUTION_URL/instance/fetchInstances" \
        -H "apikey: $EVOLUTION_KEY" \
        -H "Content-Type: application/json" 2>/dev/null)
    
    echo "DEBUG: Instances response: $INSTANCES" >&2
    
    if echo "$INSTANCES" | grep -q "\"instanceName\":\"$INSTANCE_NAME\""; then
        echo -e "${GREEN}  ✓ Instance already exists${NC}"
        return 0
    fi
    
    # Create new instance with webhook
    echo -e "${YELLOW}  Creating new instance...${NC}"
    
    RESULT=$(curl -s -X POST "$EVOLUTION_URL/instance/create" \
        -H "apikey: $EVOLUTION_KEY" \
        -H "Content-Type: application/json" \
        -d "{
            \"instanceName\": \"$INSTANCE_NAME\",
            \"integration\": \"WHATSAPP-BAILEYS\",
            \"qrcode\": true,
            \"webhook\": {
                \"url\": \"$RMD_WEBHOOK_URL\",
                \"byEvents\": false,
                \"base64\": false,
                \"headers\": {},
                \"events\": [\"MESSAGES_UPSERT\"]
            }
        }" 2>/dev/null)
    
    echo "DEBUG: Create result: $RESULT" >&2
    
    if echo "$RESULT" | grep -q '"error"'; then
        ERROR_MSG=$(echo "$RESULT" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        if echo "$ERROR_MSG" | grep -qi "already"; then
            echo -e "${GREEN}  ✓ Instance exists${NC}"
            return 0
        fi
        echo -e "${RED}Error: $ERROR_MSG${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}  ✓ Instance created${NC}"
    sleep 2
}

# ===========================================
# Get QR Code
# ===========================================
get_qr_code() {
    echo -e "${YELLOW}Getting QR Code...${NC}"
    echo ""
    
    # First check connection state
    STATE_RESULT=$(curl -s -X GET "$EVOLUTION_URL/instance/connectionState/$INSTANCE_NAME" \
        -H "apikey: $EVOLUTION_KEY" 2>/dev/null)
    
    echo "DEBUG: Connection state: $STATE_RESULT" >&2
    
    STATE=$(echo "$STATE_RESULT" | grep -o '"state":"[^"]*"' | cut -d'"' -f4 | head -1)
    
    if [ "$STATE" = "open" ]; then
        echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║         Already Connected to WhatsApp!                    ║${NC}"
        echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
        show_success
        return 0
    fi
    
    # Connect to get QR code
    CONNECT_RESULT=$(curl -s -X GET "$EVOLUTION_URL/instance/connect/$INSTANCE_NAME" \
        -H "apikey: $EVOLUTION_KEY" 2>/dev/null)
    
    echo "DEBUG: Connect result: ${CONNECT_RESULT:0:200}..." >&2
    
    # Try to extract QR code (different formats)
    QR_BASE64=$(echo "$CONNECT_RESULT" | grep -o '"base64":"[^"]*"' | head -1 | cut -d'"' -f4)
    QR_CODE=$(echo "$CONNECT_RESULT" | grep -o '"code":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    # Also try nested format
    if [ -z "$QR_BASE64" ]; then
        QR_BASE64=$(echo "$CONNECT_RESULT" | sed 's/.*"base64":"\([^"]*\)".*/\1/' 2>/dev/null | head -1)
    fi
    
    if [ -n "$QR_BASE64" ] && [ "$QR_BASE64" != "$CONNECT_RESULT" ]; then
        echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
        echo -e "${GREEN}║                   Scan QR Code                            ║${NC}"
        echo -e "${GREEN}╠═══════════════════════════════════════════════════════════╣${NC}"
        echo -e "${GREEN}║                                                           ║${NC}"
        echo -e "${GREEN}║  1. Open WhatsApp on your phone                           ║${NC}"
        echo -e "${GREEN}║  2. Tap Menu (⋮) > Linked Devices                         ║${NC}"
        echo -e "${GREEN}║  3. Tap 'Link a Device'                                   ║${NC}"
        echo -e "${GREEN}║  4. Scan the QR code                                      ║${NC}"
        echo -e "${GREEN}║                                                           ║${NC}"
        echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
        echo ""
        
        # Save QR as image
        QR_FILE="/tmp/whatsapp-qr-$$.png"
        
        # Remove data:image/png;base64, prefix if present
        CLEAN_BASE64=$(echo "$QR_BASE64" | sed 's/^data:image\/[^;]*;base64,//')
        echo "$CLEAN_BASE64" | base64 -d > "$QR_FILE" 2>/dev/null
        
        if [ -f "$QR_FILE" ] && [ -s "$QR_FILE" ]; then
            echo -e "${CYAN}QR Code saved to: $QR_FILE${NC}"
            
            # Try to open image viewer
            if command -v xdg-open &> /dev/null; then
                echo -e "${CYAN}Opening QR code image...${NC}"
                xdg-open "$QR_FILE" 2>/dev/null &
            elif command -v open &> /dev/null; then
                open "$QR_FILE" 2>/dev/null &
            else
                echo -e "${YELLOW}Open the file manually: $QR_FILE${NC}"
            fi
        fi
        echo ""
        
        # Wait for connection
        wait_for_connection
    else
        echo -e "${YELLOW}Could not get QR code. Retrying...${NC}"
        sleep 3
        get_qr_code
    fi
}

# ===========================================
# Wait for connection
# ===========================================
wait_for_connection() {
    echo -e "${YELLOW}Waiting for WhatsApp connection...${NC}"
    echo "(Scan the QR code with your phone - Press Ctrl+C to cancel)"
    echo ""
    
    for i in {1..120}; do
        STATE_RESULT=$(curl -s -X GET "$EVOLUTION_URL/instance/connectionState/$INSTANCE_NAME" \
            -H "apikey: $EVOLUTION_KEY" 2>/dev/null)
        
        STATE=$(echo "$STATE_RESULT" | grep -o '"state":"[^"]*"' | cut -d'"' -f4 | head -1)
        
        if [ "$STATE" = "open" ]; then
            echo ""
            echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
            echo -e "${GREEN}║              Connected Successfully!                      ║${NC}"
            echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
            show_success
            return 0
        fi
        
        printf "."
        sleep 2
    done
    
    echo ""
    echo -e "${RED}Timeout. Please run the script again.${NC}"
    exit 1
}

# ===========================================
# Show success info
# ===========================================
show_success() {
    echo ""
    echo -e "${GREEN}WhatsApp is now connected!${NC}"
    echo ""
    echo -e "Instance:  ${CYAN}$INSTANCE_NAME${NC}"
    echo -e "Webhook:   ${CYAN}$RMD_WEBHOOK_URL${NC}"
    echo ""
    echo -e "${YELLOW}What happens now:${NC}"
    echo "  • Messages you receive go to our AI pipeline"
    echo "  • Events & reminders are extracted automatically"
    echo "  • You get push notifications"
    echo ""
    echo -e "${YELLOW}Test it:${NC}"
    echo "  Send yourself a WhatsApp message like:"
    echo -e "  ${CYAN}\"Meeting tomorrow at 3pm\"${NC}"
    echo ""
    echo -e "${YELLOW}View incoming messages:${NC}"
    echo -e "  ${CYAN}tail -f logs/rmd.log${NC}"
    echo ""
}

# ===========================================
# Main
# ===========================================
main() {
    check_evolution
    create_instance
    get_qr_code
}

main "$@"
