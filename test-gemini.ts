/**
 * Test Gemini LLM integration
 */

import { config } from './src/config/index.js';
import { classifyMessage } from './src/pipeline/classifier.js';
import { extractEvent } from './src/pipeline/extractor.js';

console.log('=== GEMINI INTEGRATION TEST ===\n');

console.log('Configuration:');
console.log('  Gemini API Key:', config.geminiApiKey ? '✅ Set' : '❌ Not set');
console.log('  Gemini Model:', config.geminiModel);
console.log('  Gemini API URL:', config.geminiApiUrl);
console.log('  OpenAI API Key:', config.openaiApiKey ? '✅ Set' : '❌ Not set');
console.log('');

const testMessages = [
  'bring vegetable on your way home today',
  'meeting tomorrow at 3pm with John',
  'hello there',
];

console.log('=== CLASSIFICATION TEST (Gemini) ===\n');

for (const msg of testMessages) {
  console.log(`Message: "${msg}"`);
  try {
    const result = await classifyMessage(msg);
    console.log(`  ✅ Result: ${result.event_type} (confidence: ${result.confidence})`);
  } catch (error) {
    console.log(`  ❌ Error: ${error}`);
  }
  console.log('');
}

console.log('=== EXTRACTION TEST (Gemini) ===\n');

const extractionTest = `
CURRENT MESSAGE:
Sender: Akshat
Content: Meeting with Rohan tomorrow at 4pm for project discussion
Time: 2026-02-03 16:30 IST

MESSAGE HISTORY:
(No previous messages)
`;

console.log('Testing extraction with context:');
console.log(extractionTest);

try {
  const result = await extractEvent(extractionTest);
  console.log('✅ Extraction Result:');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(`❌ Error: ${error}`);
}

console.log('\n=== TEST COMPLETE ===');
