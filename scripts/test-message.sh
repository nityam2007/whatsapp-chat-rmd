#!/bin/bash

# ===========================================
# WhatsApp Chat RMD - Test Message Script
# ===========================================

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

MESSAGE="${1:-Meeting tomorrow at 3pm with the team}"
SENDER="${2:-Test User}"
CHAT_ID="${3:-test-chat}"

echo -e "${BLUE}Sending test message...${NC}"
echo "  Message: $MESSAGE"
echo "  Sender:  $SENDER"
echo ""

RESPONSE=$(curl -s -X POST http://localhost:3000/webhook/test \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"$MESSAGE\", \"sender\": \"$SENDER\", \"chat_id\": \"$CHAT_ID\"}")

echo -e "${GREEN}Response:${NC}"
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
