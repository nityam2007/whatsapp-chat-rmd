#!/usr/bin/env npx ts-node
/**
 * Quick E2E Test - Single Scenario Runner
 * 
 * Tests a specific scenario with detailed output.
 * Waits for pipeline completion and shows database results.
 * 
 * Usage:
 *   npx tsx scripts/e2e-quick.ts [scenario]
 * 
 * Scenarios:
 *   1 - Event creation
 *   2 - Event update  
 *   3 - Casual drop
 *   4 - Time-only update
 *   5 - Hindi message
 *   all - Run all (default)
 */

import { v4 as uuidv4 } from 'uuid';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const WEBHOOK_URL = `${BASE_URL}/webhook/evolution`;

// Colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

interface TestCase {
  name: string;
  messages: Array<{
    content: string;
    from: string;
    chatId: string;
    isFromMe: boolean;
    waitAfter?: number;
  }>;
  expected: string;
}

const CHAT_ID = '919664833459@s.whatsapp.net';

const SCENARIOS: Record<string, TestCase> = {
  '1': {
    name: 'Event Creation',
    expected: 'Should create new event',
    messages: [
      { content: 'meeting tomorrow at 3 PM', from: 'Akshat', chatId: CHAT_ID, isFromMe: false },
    ],
  },
  '2': {
    name: 'Event Update',
    expected: 'First message creates, second updates',
    messages: [
      { content: 'call me at 5 PM today', from: 'Akshat', chatId: CHAT_ID, isFromMe: false, waitAfter: 3000 },
      { content: 'make it 7 PM', from: 'Akshat', chatId: CHAT_ID, isFromMe: false },
    ],
  },
  '3': {
    name: 'Casual Message (Should Drop)',
    expected: 'Should NOT create event',
    messages: [
      { content: 'hey bring potato on your way back home', from: 'Mom', chatId: '919876543210@s.whatsapp.net', isFromMe: false },
      { content: 'ok thanks', from: 'Me', chatId: '919876543210@s.whatsapp.net', isFromMe: true },
    ],
  },
  '4': {
    name: 'Time-Only Update',
    expected: 'Short time message should UPDATE recent event',
    messages: [
      { content: 'lets meet today evening', from: 'Friend', chatId: '919555555555@s.whatsapp.net', isFromMe: false, waitAfter: 3000 },
      { content: 'now at 5 PM', from: 'Friend', chatId: '919555555555@s.whatsapp.net', isFromMe: false },
    ],
  },
  '5': {
    name: 'Hindi Message',
    expected: 'Should create event from Hindi',
    messages: [
      { content: 'kal 10 baje milte hai office mein', from: 'Boss', chatId: '919123456789@s.whatsapp.net', isFromMe: false },
    ],
  },
  '6': {
    name: 'Reminder/Task',
    expected: 'Should create reminder event',
    messages: [
      { content: 'remind me to buy groceries tomorrow morning', from: 'Me', chatId: CHAT_ID, isFromMe: true },
    ],
  },
};

function createPayload(msg: { content: string; from: string; chatId: string; isFromMe: boolean }) {
  return {
    event: 'messages.upsert',
    instance: 'test-instance',
    data: {
      key: {
        remoteJid: msg.chatId,
        fromMe: msg.isFromMe,
        id: `E2E_${uuidv4()}`,
      },
      pushName: msg.from,
      message: { conversation: msg.content },
      messageType: 'conversation',
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

async function sendAndWait(msg: { content: string; from: string; chatId: string; isFromMe: boolean }, waitMs: number = 500) {
  const payload = createPayload(msg);
  const msgId = payload.data.key.id;
  
  const direction = msg.isFromMe ? 'Me ->' : `${msg.from} ->`;
  console.log(`  ${C.cyan}${direction}${C.reset} "${msg.content}"`);
  
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    console.log(`    ${C.dim}Status: ${result.status} | ID: ${msgId.slice(0, 15)}...${C.reset}`);
    
    // Wait for pipeline
    await new Promise(r => setTimeout(r, waitMs));
    
    return { msgId, status: result.status };
  } catch (e) {
    console.log(`    ${C.red}ERROR: ${e}${C.reset}`);
    return { msgId, status: 'error' };
  }
}

async function runScenario(key: string) {
  const scenario = SCENARIOS[key];
  if (!scenario) {
    console.log(`${C.red}Unknown scenario: ${key}${C.reset}`);
    return;
  }
  
  console.log(`\n${C.bold}${C.blue}=== ${scenario.name} ===${C.reset}`);
  console.log(`${C.yellow}Expected: ${scenario.expected}${C.reset}\n`);
  
  for (const msg of scenario.messages) {
    await sendAndWait(msg, msg.waitAfter || 2500);
  }
  
  console.log(`\n${C.green}Done. Check logs for pipeline results.${C.reset}`);
}

async function main() {
  const arg = process.argv[2] || 'all';
  
  console.log(`${C.bold}${C.cyan}E2E Quick Test${C.reset}`);
  console.log(`Target: ${WEBHOOK_URL}`);
  console.log(`Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  
  // Health check
  try {
    const health = await fetch(`${BASE_URL}/webhook/health`);
    const h = await health.json();
    console.log(`${C.green}Server: ${h.status}${C.reset}`);
  } catch {
    console.log(`${C.red}Server not running!${C.reset}`);
    process.exit(1);
  }
  
  if (arg === 'all') {
    for (const key of Object.keys(SCENARIOS)) {
      await runScenario(key);
    }
  } else {
    await runScenario(arg);
  }
  
  console.log(`\n${C.bold}Verification commands:${C.reset}`);
  console.log(`  sqlite3 data/db/events.db "SELECT title, status, start_time_ist FROM events ORDER BY created_at DESC LIMIT 5;"`);
  console.log(`  sqlite3 data/db/events.db "SELECT content, classification_type, heuristic_passed FROM messages ORDER BY created_at DESC LIMIT 10;"`);
}

main().catch(console.error);
