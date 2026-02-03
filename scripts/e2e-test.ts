#!/usr/bin/env npx ts-node
/**
 * E2E Test Script for Message Pipeline
 * 
 * Tests 6 types of message scenarios through the FULL pipeline:
 * 1. Clear event creation (should create event)
 * 2. Event update (should update existing event)  
 * 3. Casual message (should be dropped - no event)
 * 4. Task/reminder (should create event)
 * 5. Cancellation (should cancel existing event)
 * 6. Multi-message conversation block
 * 
 * Usage:
 *   npm run e2e-test
 *   # OR
 *   npx ts-node scripts/e2e-test.ts
 * 
 * Requires: Server running on localhost:3000
 */

import { v4 as uuidv4 } from 'uuid';

// Configuration
const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const WEBHOOK_URL = `${BASE_URL}/webhook/evolution`;
const DELAY_BETWEEN_MESSAGES = 2000; // ms - allow pipeline to process
const DELAY_FOR_CONVERSATION = 500; // ms - shorter delay within conversations

// Test contacts (simulating different chats)
const CONTACTS = {
  akshat: '919664833459@s.whatsapp.net',
  mom: '919876543210@s.whatsapp.net',
  boss: '919123456789@s.whatsapp.net',
  friend: '919555555555@s.whatsapp.net',
};

// Colors for console output
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

interface TestMessage {
  content: string;
  chatId: string;
  senderName: string;
  isFromMe: boolean;
}

interface TestScenario {
  name: string;
  description: string;
  messages: TestMessage[];
  expectedOutcome: 'event_created' | 'event_updated' | 'dropped' | 'event_cancelled' | 'multiple';
  waitAfter?: number;
}

/**
 * Create Evolution API webhook payload
 */
function createWebhookPayload(message: TestMessage) {
  const messageId = `E2E_${uuidv4()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  
  return {
    event: 'messages.upsert',
    instance: 'test-instance',
    data: {
      key: {
        remoteJid: message.chatId,
        fromMe: message.isFromMe,
        id: messageId,
        participant: message.isFromMe ? undefined : message.chatId,
      },
      pushName: message.senderName,
      message: {
        conversation: message.content,
      },
      messageType: 'conversation',
      messageTimestamp: timestamp,
    },
  };
}

/**
 * Send message through webhook
 */
async function sendMessage(message: TestMessage): Promise<{ status: string; messageId?: string }> {
  const payload = createWebhookPayload(message);
  
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    const result = await response.json();
    return {
      status: result.status || 'unknown',
      messageId: payload.data.key.id,
    };
  } catch (error) {
    console.error(`${COLORS.red}Failed to send message:${COLORS.reset}`, error);
    throw error;
  }
}

/**
 * Wait for specified milliseconds
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log test header
 */
function logHeader(text: string) {
  console.log('\n' + '='.repeat(70));
  console.log(`${COLORS.bright}${COLORS.cyan}${text}${COLORS.reset}`);
  console.log('='.repeat(70));
}

/**
 * Log scenario info
 */
function logScenario(scenario: TestScenario, index: number) {
  console.log(`\n${COLORS.bright}${COLORS.blue}[SCENARIO ${index + 1}] ${scenario.name}${COLORS.reset}`);
  console.log(`${COLORS.yellow}Expected: ${scenario.expectedOutcome}${COLORS.reset}`);
  console.log(`Description: ${scenario.description}`);
  console.log('-'.repeat(50));
}

/**
 * Log message being sent
 */
function logMessage(message: TestMessage, result: { status: string; messageId?: string }) {
  const direction = message.isFromMe ? 'Me ->' : `${message.senderName} ->`;
  const statusColor = result.status === 'processing' ? COLORS.green : COLORS.yellow;
  
  console.log(`  ${COLORS.magenta}${direction}${COLORS.reset} "${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}"`);
  console.log(`    ${statusColor}Status: ${result.status}${COLORS.reset} | ID: ${result.messageId?.substring(0, 20)}...`);
}

// ============================================================================
// TEST SCENARIOS - Simulating real human message patterns
// ============================================================================

const TEST_SCENARIOS: TestScenario[] = [
  // -------------------------------------------------------------------------
  // SCENARIO 1: Clear Event Creation
  // -------------------------------------------------------------------------
  {
    name: 'Clear Event Creation',
    description: 'Simple meeting request - should create new event',
    expectedOutcome: 'event_created',
    messages: [
      {
        content: 'meeting tomorrow at 3 PM with the design team',
        chatId: CONTACTS.boss,
        senderName: 'Boss',
        isFromMe: false,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 2: Event Update (Time Change)
  // -------------------------------------------------------------------------
  {
    name: 'Event Update - Time Change',
    description: 'User updates a recently created event with new time',
    expectedOutcome: 'event_updated',
    waitAfter: 3000, // Wait for first event to be created
    messages: [
      // First create an event
      {
        content: 'call me at 5 PM today',
        chatId: CONTACTS.akshat,
        senderName: 'Akshat',
        isFromMe: false,
      },
      // Then update it (short delay between)
      {
        content: 'actually make it 7 PM',
        chatId: CONTACTS.akshat,
        senderName: 'Akshat',
        isFromMe: false,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 3: Casual Messages (Should be dropped)
  // -------------------------------------------------------------------------
  {
    name: 'Casual Messages - Should Drop',
    description: 'Non-event messages that should NOT create events',
    expectedOutcome: 'dropped',
    messages: [
      {
        content: 'hey bring potato on your way back home',
        chatId: CONTACTS.mom,
        senderName: 'Mom',
        isFromMe: false,
      },
      {
        content: 'ok thanks',
        chatId: CONTACTS.friend,
        senderName: 'Friend',
        isFromMe: true,
      },
      {
        content: 'lol that was funny',
        chatId: CONTACTS.friend,
        senderName: 'Friend',
        isFromMe: false,
      },
      {
        content: 'haha yeah',
        chatId: CONTACTS.friend,
        senderName: 'Me',
        isFromMe: true,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 4: Tasks and Reminders
  // -------------------------------------------------------------------------
  {
    name: 'Tasks and Reminders',
    description: 'Various reminder formats humans use',
    expectedOutcome: 'event_created',
    messages: [
      {
        content: 'remind me to buy groceries tomorrow morning',
        chatId: CONTACTS.mom,
        senderName: 'Me',
        isFromMe: true,
      },
      {
        content: 'dont forget to submit the report by friday 5pm',
        chatId: CONTACTS.boss,
        senderName: 'Boss',
        isFromMe: false,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 5: Cancellation
  // -------------------------------------------------------------------------
  {
    name: 'Event Cancellation',
    description: 'Cancelling a previously created event',
    expectedOutcome: 'event_cancelled',
    messages: [
      // First create
      {
        content: 'dinner at 8pm tonight at the new restaurant',
        chatId: CONTACTS.friend,
        senderName: 'Friend',
        isFromMe: false,
      },
      // Then cancel
      {
        content: 'cancel dinner tonight, not feeling well',
        chatId: CONTACTS.friend,
        senderName: 'Friend',
        isFromMe: false,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 6: Multi-Message Conversation Block
  // -------------------------------------------------------------------------
  {
    name: 'Multi-Message Conversation',
    description: 'Realistic back-and-forth chat leading to event',
    expectedOutcome: 'multiple',
    messages: [
      {
        content: 'hey are you free this weekend?',
        chatId: CONTACTS.akshat,
        senderName: 'Akshat',
        isFromMe: false,
      },
      {
        content: 'yeah I think so, whats up?',
        chatId: CONTACTS.akshat,
        senderName: 'Me',
        isFromMe: true,
      },
      {
        content: 'want to catch a movie?',
        chatId: CONTACTS.akshat,
        senderName: 'Akshat',
        isFromMe: false,
      },
      {
        content: 'sure! when?',
        chatId: CONTACTS.akshat,
        senderName: 'Me',
        isFromMe: true,
      },
      {
        content: 'lets do saturday 7pm at PVR',
        chatId: CONTACTS.akshat,
        senderName: 'Akshat',
        isFromMe: false,
      },
      {
        content: 'perfect, see you there!',
        chatId: CONTACTS.akshat,
        senderName: 'Me',
        isFromMe: true,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 7: Hindi/Hinglish Messages
  // -------------------------------------------------------------------------
  {
    name: 'Hindi/Hinglish Messages',
    description: 'Common Indian message patterns',
    expectedOutcome: 'event_created',
    messages: [
      {
        content: 'kal 10 baje milte hai office mein',
        chatId: CONTACTS.boss,
        senderName: 'Boss',
        isFromMe: false,
      },
      {
        content: 'aaj raat 9 baje call karna',
        chatId: CONTACTS.mom,
        senderName: 'Mom',
        isFromMe: false,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // SCENARIO 8: Time-Only Updates (The potato bug case)
  // -------------------------------------------------------------------------
  {
    name: 'Time-Only Update Messages',
    description: 'Short messages that update time of recent events',
    expectedOutcome: 'event_updated',
    messages: [
      // Create event first
      {
        content: 'lets meet today evening',
        chatId: CONTACTS.friend,
        senderName: 'Friend',
        isFromMe: false,
      },
      // Short time update
      {
        content: 'now at 5 PM',
        chatId: CONTACTS.friend,
        senderName: 'Friend',
        isFromMe: false,
      },
    ],
  },
];

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

async function runTests() {
  logHeader('E2E MESSAGE PIPELINE TEST');
  console.log(`Target: ${WEBHOOK_URL}`);
  console.log(`Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  console.log(`Total Scenarios: ${TEST_SCENARIOS.length}`);
  
  // Check if server is running
  try {
    const healthCheck = await fetch(`${BASE_URL}/webhook/health`);
    const health = await healthCheck.json();
    console.log(`${COLORS.green}Server Status: ${health.status}${COLORS.reset}`);
  } catch (error) {
    console.error(`${COLORS.red}ERROR: Server not running at ${BASE_URL}${COLORS.reset}`);
    console.log('Please start the server with: npm start');
    process.exit(1);
  }

  const results: { scenario: string; success: boolean; messages: number }[] = [];

  // Run each scenario
  for (let i = 0; i < TEST_SCENARIOS.length; i++) {
    const scenario = TEST_SCENARIOS[i];
    logScenario(scenario, i);
    
    let successCount = 0;
    
    for (const message of scenario.messages) {
      try {
        const result = await sendMessage(message);
        logMessage(message, result);
        
        if (result.status === 'processing' || result.status === 'ignored') {
          successCount++;
        }
        
        // Delay between messages in same scenario
        await wait(DELAY_FOR_CONVERSATION);
      } catch (error) {
        console.error(`${COLORS.red}  ERROR sending message${COLORS.reset}`);
      }
    }
    
    results.push({
      scenario: scenario.name,
      success: successCount === scenario.messages.length,
      messages: scenario.messages.length,
    });
    
    // Wait after scenario for pipeline to complete
    const waitTime = scenario.waitAfter || DELAY_BETWEEN_MESSAGES;
    console.log(`\n  ${COLORS.cyan}Waiting ${waitTime}ms for pipeline...${COLORS.reset}`);
    await wait(waitTime);
  }

  // Print summary
  logHeader('TEST SUMMARY');
  
  let passed = 0;
  let failed = 0;
  
  for (const result of results) {
    const status = result.success 
      ? `${COLORS.green}SENT${COLORS.reset}` 
      : `${COLORS.red}FAILED${COLORS.reset}`;
    console.log(`  ${status} ${result.scenario} (${result.messages} messages)`);
    
    if (result.success) passed++;
    else failed++;
  }
  
  console.log('\n' + '-'.repeat(50));
  console.log(`Total: ${TEST_SCENARIOS.length} scenarios`);
  console.log(`${COLORS.green}Sent: ${passed}${COLORS.reset}`);
  console.log(`${COLORS.red}Failed: ${failed}${COLORS.reset}`);
  
  console.log(`\n${COLORS.yellow}NOTE: Check server logs and database for actual pipeline results.${COLORS.reset}`);
  console.log('Run these commands to verify:');
  console.log('  sqlite3 data/db/events.db "SELECT id, title, status, start_time_ist, chat_id FROM events ORDER BY created_at DESC LIMIT 10;"');
  console.log('  sqlite3 data/db/events.db "SELECT id, content, classification_type, heuristic_passed FROM messages ORDER BY created_at DESC LIMIT 20;"');
}

// Run if executed directly
runTests().catch(console.error);
