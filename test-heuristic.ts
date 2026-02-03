/**
 * Test script for heuristic gate and rule engine
 * Tests the pending confirmation feature for tasks without explicit time
 */

import { checkHeuristicGate } from './src/pipeline/heuristicGate.js';
import { extractWithRules } from './src/pipeline/ruleEngine.js';

// Test messages including those with contextual triggers
const testMessages = [
  // Tasks with contextual triggers (should get pending_confirmation)
  'bring vegetable on your way home',
  'bring vegetables on your way home today',
  'get milk when you leave office',
  'pick up groceries on your way home',
  
  // Tasks without any time (should get pending_confirmation)
  'bring sabzi',
  'get milk',
  'buy bread',
  
  // Tasks with contextual time
  'buy coffee after work',
  'get lunch during lunch break',
  
  // Tasks with explicit time (should NOT need confirmation)
  'reminder to call mom at 5pm',
  'meeting tomorrow at 3pm',
  'buy groceries today at 6pm',
  
  // Non-task messages
  'what time is the meeting?',
  'hello there',
];

console.log('=== PENDING CONFIRMATION FEATURE TEST ===\n');
console.log('Testing rule engine with tasks and contextual triggers\n');

console.log('=== HEURISTIC GATE TEST ===\n');
for (const msg of testMessages) {
  const result = checkHeuristicGate(msg);
  const status = result.hasSignal ? '✅' : '❌';
  console.log(`${status} "${msg}"`);
  console.log(`   score: ${result.score} | signals: ${result.signals.slice(0, 3).join(', ')}`);
}

console.log('\n=== RULE ENGINE TEST ===\n');
console.log('Legend: isTask=task pattern, hasTrigger=contextual trigger, skipLLM=can skip LLM\n');

for (const msg of testMessages) {
  const result = extractWithRules(msg);
  const skipStatus = result.skipLLM ? '✅ SKIP' : '❌ LLM';
  const needsConfirm = (result.isTask && !result.event?.start_time) || result.hasContextualTrigger;
  const confirmStatus = needsConfirm ? '🔔 CONFIRM' : '⏰ SCHEDULED';
  
  console.log(`"${msg}"`);
  console.log(`   ${skipStatus} | ${confirmStatus}`);
  console.log(`   isTask: ${result.isTask} | hasTrigger: ${result.hasContextualTrigger} | confidence: ${result.confidence.toFixed(2)}`);
  
  if (result.event) {
    console.log(`   title: "${result.event.title}"`);
    console.log(`   time: ${result.event.start_time || 'null'}`);
    if (result.contextualTrigger) {
      console.log(`   trigger: ${result.contextualTrigger.type} = "${result.contextualTrigger.value}"`);
    }
    if (result.event.condition.type) {
      console.log(`   condition: ${result.event.condition.type} = "${result.event.condition.value}"`);
    }
  }
  console.log(`   patterns: ${result.matchedPatterns.join(', ')}`);
  console.log('');
}

console.log('=== SUMMARY ===\n');
const results = testMessages.map(msg => {
  const result = extractWithRules(msg);
  return {
    msg,
    skipLLM: result.skipLLM,
    isTask: result.isTask,
    hasContextualTrigger: result.hasContextualTrigger,
    hasTime: !!result.event?.start_time,
    needsConfirmation: (result.isTask && !result.event?.start_time) || result.hasContextualTrigger,
  };
});

const tasksWithConfirmation = results.filter(r => r.needsConfirmation && r.skipLLM);
const tasksWithTime = results.filter(r => r.skipLLM && r.hasTime);
const needsLLM = results.filter(r => !r.skipLLM);

console.log(`Tasks needing confirmation: ${tasksWithConfirmation.length}`);
console.log(`Tasks with scheduled time: ${tasksWithTime.length}`);
console.log(`Messages needing LLM: ${needsLLM.length}`);
