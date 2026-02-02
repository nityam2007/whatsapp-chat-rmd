/**
 * Heuristic Gate Module
 * 
 * Fast keyword-based filtering before LLM processing.
 * Detects signals that indicate potential event-related content.
 * 
 * DESIGNED FOR:
 * - Casual human speech ("bring milk", "call mom", "pick up kids")
 * - WhatsApp-style short messages
 * - Hinglish (Hindi + English) common phrases
 * - Regional Indian languages (Tamil, Telugu, Marathi, Bengali, Gujarati)
 * - Typos and variations
 */

import { HeuristicResult } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Configurable threshold (default from config or fallback)
const HEURISTIC_THRESHOLD = config.heuristicThreshold ?? 1;

// Signal keywords grouped by category with extensive coverage
const SIGNAL_KEYWORDS = {
  // Time-related words
  time: [
    // Days
    'today', 'tomorrow', 'yesterday', 'tonight', 'tonite', 'tmrw', 'tmr', 'tomo',
    'morning', 'afternoon', 'evening', 'night', 'noon', 'midnight',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
    // Months
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    // Time units
    'am', 'pm', 'o\'clock', 'oclock', 'hour', 'hours', 'hr', 'hrs',
    'minute', 'minutes', 'min', 'mins',
    'second', 'seconds', 'sec', 'secs',
    // Relative time
    'week', 'month', 'year', 'next', 'last', 'this', 'coming', 'following',
    'soon', 'later', 'early', 'late', 'sharp', 'around', 'about', 'by', 'until', 'before', 'after',
    'asap', 'eod', 'eow', 'end of day', 'end of week',
    // Casual time expressions
    'half past', 'quarter past', 'quarter to', 'ish', 'esque',
    'whenever', 'sometime', 'someday', 'anytime',
    // Hindi/Hinglish time words
    'kal', 'aaj', 'abhi', 'baad', 'baad mein', 'shaam', 'subah', 'raat', 'dopahar',
    'parso', 'parson', 'narsoon', // day after tomorrow, day after that
    'baje', 'bajhe', 'ghante', // o'clock, hours
    // Tamil time words
    'inru', 'naalai', 'naalaikku', 'netru', 'innaikku', // today, tomorrow, yesterday
    'kaalaila', 'maalai', 'iravu', // morning, evening, night
    'manikku', // at (time)
    // Telugu time words
    'ippudu', 'repu', 'ninna', 'eeroju', // now, tomorrow, yesterday, today
    'udayam', 'sayantram', 'ratri', // morning, evening, night
    // Marathi time words
    'aata', 'udya', 'kal', 'aaj', // now, tomorrow, yesterday, today
    'sakali', 'sandhyakali', 'ratri', // morning, evening, night
    // Bengali time words
    'aj', 'aaj', 'kal', 'agamikal', 'porsu', // today, tomorrow, day after
    'sokal', 'bikel', 'rat', 'dupure', // morning, evening, night, afternoon
    // Gujarati time words  
    'aaje', 'kale', 'parase', // today, tomorrow, day after
    'savare', 'sanje', 'raate', // morning, evening, night
  ],

  // Event types
  event: [
    // Formal events
    'meeting', 'call', 'appointment', 'event', 'party', 'birthday', 'wedding', 'conference',
    'presentation', 'interview', 'session', 'class', 'lecture', 'seminar', 'workshop',
    // Social events
    'dinner', 'lunch', 'breakfast', 'brunch', 'date', 'hangout', 'get together', 'gathering',
    'coffee', 'tea', 'drinks', 'movie', 'film', 'show', 'concert', 'game', 'match',
    // Travel
    'flight', 'trip', 'travel', 'vacation', 'holiday', 'train', 'bus', 'cab', 'uber', 'ola',
    // Work/Academic
    'deadline', 'due', 'submission', 'exam', 'test', 'quiz', 'viva', 'review',
    'standup', 'sync', 'catchup', 'catch up', 'one on one', '1:1', '1-1',
    // Medical
    'doctor', 'dentist', 'appointment', 'checkup', 'check up', 'hospital', 'clinic',
    // Tasks
    'task', 'todo', 'to do', 'to-do', 'errand', 'chore',
    // Hindi event words
    'baithak', 'milna', 'mulakat', 'dawat', 'shaadi', 'function', 'program',
    'pariksha', 'test', 'safar', 'yatra',
    // Tamil event words
    'koottam', 'sandippu', 'kalyanam', 'vizha', 'tervai', // meeting, wedding, festival, exam
    // Telugu event words
    'samavesham', 'kalyanam', 'pandaga', 'pariksha', // meeting, wedding, festival, exam
    // Marathi event words
    'bhetat', 'lagna', 'san', 'pariksha', // meeting, wedding, festival, exam
  ],

  // Action verbs (casual reminders)
  action: [
    // Reminder actions
    'remind', 'reminder', 'remember', 'don\'t forget', 'dont forget', 'do not forget',
    'note', 'note down', 'jot down', 'write down',
    // Scheduling
    'schedule', 'scheduled', 'plan', 'planned', 'planning', 'book', 'booking', 'reserve', 'reservation',
    // Meeting actions
    'meet', 'meeting', 'join', 'attend', 'attending', 'coming', 'going',
    // Communication
    'call', 'calling', 'ring', 'phone', 'text', 'message', 'msg', 'whatsapp', 'email', 'mail',
    // Physical actions (errands)
    'pick up', 'pickup', 'drop off', 'dropoff', 'drop', 'collect', 'fetch',
    'bring', 'take', 'carry', 'get', 'buy', 'purchase', 'order',
    'return', 'submit', 'send', 'deliver', 'post', 'courier',
    'pay', 'payment', 'transfer', 'deposit', 'withdraw',
    'clean', 'wash', 'iron', 'cook', 'prepare', 'make',
    // Status changes
    'start', 'begin', 'end', 'finish', 'complete', 'done',
    'cancel', 'cancelled', 'canceled', 'postpone', 'postponed', 'reschedule', 'rescheduled',
    'skip', 'drop', 'abort', 'call off',
    // Compound actions
    'need to', 'have to', 'got to', 'gotta', 'gonna', 'should', 'must', 'will',
    'want to', 'wanna', 'planning to', 'going to',
    // Hindi/Hinglish actions
    'karna', 'karo', 'karenge', 'karke', 'karle', 'kijiye',
    'lena', 'lo', 'lenge', 'leke', 'lele', 'lijiye',
    'dena', 'do', 'denge', 'deke', 'dele', 'dijiye',
    'bhejna', 'bhejo', 'bhejdo', 'bhejdena',
    'lana', 'lao', 'laao', 'le aao', 'le aana',
    'jana', 'jao', 'jaao', 'chalo', 'chalte',
    'aana', 'aao', 'aaiye', 'aa jaao', 'aa jana',
    'yaad', 'yaad rakh', 'yaad rakhna', 'yaad dilana', 'yaad karwa dena',
    'bhool mat', 'bhoolna mat', 'mat bhoolna', 'bhool na jaana',
    'milna', 'milo', 'milte', 'milenge',
    'batana', 'bata dena', 'batao', 'bolo',
    // Tamil action words
    'seyya', 'pannu', 'pannunga', 'eduthu', 'kudukka', // do, give
    'vara', 'vanga', 'ponga', // come, go
    'call pannu', 'msg pannu', // call, message
    'kooppidu', 'sollu', 'sollungo', // call, tell
    'marakkathe', 'gnapakapaduthy', // don't forget, remind
    // Telugu action words
    'cheyyi', 'cheyyandi', 'ivvu', 'ivvandi', // do, give
    'ra', 'randi', 'po', 'vellandi', // come, go
    'call cheyyi', 'phone cheyyi', // call
    'marchipoku', 'gurthu', 'gurthu cheppu', // don't forget, remind
    // Marathi action words
    'kara', 'karat', 'karayla', 'dya', 'ghya', // do, give, take
    'ya', 'ja', 'yaa', 'jaa', // come, go
    'visaru naka', 'athvan kara', // don't forget, remind
    'phone kara', 'call kara', // call
    // Bengali action words
    'koro', 'korbe', 'dao', 'nao', // do, give, take
    'esho', 'jao', 'asho', 'jabe', // come, go
    'bhulona', 'mone rekho', 'mone korao', // don't forget, remind
    // Gujarati action words
    'karo', 'karjo', 'aapo', 'lo', // do, give, take
    'aavo', 'jao', 'avjo', // come, go
    'bhulta nahi', 'yaad rakhjo', // don't forget, remind
  ],

  // Update/change indicators
  update: [
    'change', 'changed', 'update', 'updated', 'move', 'moved', 'shift', 'shifted',
    'new time', 'new date', 'new location', 'new venue', 'new place',
    'postponed', 'rescheduled', 'cancelled', 'canceled',
    'instead', 'actually', 'correction', 'sorry', 'my bad', 'oops',
    'not', 'won\'t', 'wont', 'can\'t', 'cant', 'cannot',
    // Hindi
    'badal', 'badlo', 'badal diya', 'badal gaya', 'hatao', 'cancel karo',
    // Tamil
    'maathi', 'maathidu', 'cancel pannu',
    // Telugu
    'maarchu', 'cancel cheyyi',
    // Marathi
    'badla', 'cancel kara',
  ],

  // Locations
  location: [
    'at', 'in', 'near', 'location', 'venue', 'place', 'address', 'where',
    'office', 'home', 'house', 'work', 'school', 'college', 'university',
    'restaurant', 'cafe', 'coffee shop', 'hotel', 'airport', 'station', 'stop',
    'mall', 'market', 'shop', 'store', 'supermarket', 'grocery',
    'room', 'floor', 'building', 'street', 'road', 'lane', 'area',
    'gym', 'park', 'ground', 'stadium', 'theater', 'theatre', 'cinema',
    'bank', 'atm', 'post office', 'pharmacy', 'chemist', 'medical',
    // Hindi
    'ghar', 'daftar', 'office', 'dukan', 'bazar', 'station', 'adda',
    // Tamil
    'veedu', 'office', 'kadai', 'sandhai', 'bus stand',
    // Telugu
    'illu', 'office', 'shop', 'market',
    // Marathi
    'ghar', 'office', 'dukan', 'market',
  ],

  // People references
  people: [
    'with', 'for', 'mom', 'mum', 'mother', 'dad', 'father', 'papa', 'mummy', 'daddy',
    'brother', 'sister', 'bro', 'sis', 'bhai', 'didi', 'behen',
    'friend', 'friends', 'buddy', 'dude', 'bro', 'yaar', 'dost',
    'boss', 'manager', 'client', 'customer', 'team', 'colleague',
    'doctor', 'dr', 'sir', 'madam', 'teacher', 'professor', 'prof',
    'uncle', 'aunty', 'auntie', 'chacha', 'chachi', 'mama', 'mami',
    // Hindi
    'amma', 'abba', 'beta', 'beti', 'bachche', 'log', 'sab',
    // Tamil
    'amma', 'appa', 'anna', 'akka', 'thambi', 'thangai', 'nanbane',
    // Telugu
    'amma', 'nanna', 'anna', 'akka', 'tammudu', 'chelli', 'friend',
    // Marathi
    'aai', 'baba', 'dada', 'tai', 'bhau', 'mitra',
    // Bengali
    'ma', 'baba', 'dada', 'didi', 'bondhu',
    // Gujarati
    'ba', 'bapu', 'bhai', 'ben', 'dost',
  ],

  // Common items for errands
  items: [
    'milk', 'bread', 'eggs', 'grocery', 'groceries', 'vegetables', 'veggies', 'fruits',
    'medicine', 'meds', 'prescription', 'tablets', 'pills',
    'clothes', 'laundry', 'dry cleaning', 'ironing',
    'documents', 'papers', 'files', 'passport', 'license', 'id',
    'keys', 'wallet', 'phone', 'charger', 'laptop', 'bag',
    'gift', 'present', 'cake', 'flowers', 'bouquet',
    'ticket', 'tickets', 'pass', 'passes',
    'bill', 'bills', 'rent', 'emi', 'loan', 'recharge',
    // Hindi
    'doodh', 'sabzi', 'dawai', 'kapde', 'paisa', 'paise',
    // Tamil
    'paal', 'kaai', 'marunthu',
    // Telugu
    'paalu', 'kooralu', 'mandulu',
    // Common food items
    'chai', 'coffee', 'paani', 'water', 'roti', 'rice', 'dal', 'sabji',
  ],

  // Question indicators (might be scheduling)
  questions: [
    'when', 'what time', 'how about', 'shall we', 'can we', 'should we',
    'are you', 'will you', 'would you', 'could you',
    'free', 'available', 'busy', 'occupied',
    // Hindi
    'kab', 'kitne baje', 'kya hoga', 'hoga kya', 'chalega', 'theek hai',
    // Tamil
    'eppodu', 'evvalavu mani', 'sariya',
    // Telugu
    'eppudu', 'enni gantalu', 'sarigga',
  ],

  // Urgency indicators
  urgency: [
    'urgent', 'urgently', 'important', 'asap', 'immediately', 'now', 'right now',
    'critical', 'priority', 'high priority', 'emergency',
    'quickly', 'fast', 'hurry', 'jaldi', 'abhi',
    // Hindi
    'turant', 'fauran', 'zaruri', 'bahut zaruri', 'jaldi karo',
    // Tamil
    'udane', 'vegam', 'mukkiyam',
    // Telugu
    'ventane', 'important', 'urgent',
    // Marathi
    'tatkaal', 'laukar', 'mahtvache',
  ],
};

// Patterns that STRONGLY indicate events (high confidence)
const STRONG_PATTERNS = [
  // Time patterns
  /\d{1,2}[:\.\-]\d{2}\s*(am|pm)?/i,                              // 10:30, 10.30 AM
  /\d{1,2}\s*(am|pm)/i,                                           // 10am, 10 pm
  /\d{1,2}(st|nd|rd|th)\s*(of\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i, // 25th of Dec
  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d{1,2}/i, // Dec 25
  /\d{1,2}\/\d{1,2}(\/\d{2,4})?/i,                                // 12/25 or 12/25/2024
  /\d{4}-\d{2}-\d{2}/i,                                           // ISO date 2024-12-25
  /\d{1,2}\s*(o'?clock|oclock)/i,                                 // 3 o'clock
  /(half\s*past|quarter\s*(past|to))\s*\d{1,2}/i,                 // half past 3
  /in\s+\d+\s*(hour|hr|minute|min|day|week|month)/i,              // in 2 hours
  /\d+\s*(hour|hr|minute|min|day|week|month)\s*(from\s*now|later|ago)/i, // 2 hours later
  
  // Reminder patterns
  /remind\s*(me|us)?/i,                                           // remind me
  /don'?t\s+(forget|miss)/i,                                      // don't forget
  /remember\s+to/i,                                               // remember to
  /note\s*(down|it)?:/i,                                          // note:, note down
  /(need|have|got)\s*to\s+\w+/i,                                  // need to buy
  
  // Meeting patterns
  /let'?s\s+(meet|go|have|catch|grab|do)/i,                       // let's meet
  /see\s+you\s+(at|on|tomorrow|later|then)/i,                     // see you at
  /meeting\s+(at|on|with|about)/i,                                // meeting at/with
  /scheduled\s+(for|at|on)/i,                                     // scheduled for
  /appointment\s+(at|on|with|for)/i,                              // appointment with
  /call\s+(at|with|me|you)/i,                                     // call at 5
  
  // Action patterns
  /(bring|get|buy|pick\s*up|drop\s*off|collect)\s+\w+/i,         // bring milk
  /(submit|send|deliver|return)\s+(the|my|your|this|it)/i,       // submit the report
  /(pay|transfer)\s+(the|my|for|\d)/i,                            // pay the bill
  /\bpick\s*(me|you|him|her|them|us)\s*up\b/i,                    // pick me up
  
  // Hindi/Hinglish patterns
  /\b(kal|aaj|abhi)\s+(ko|tak|mein)?\b/i,                         // kal ko, aaj
  /\byaad\s+(se|rakh|rakhna|dilana|karwa)\b/i,                    // yaad rakh
  /\bbhool\s*(na|mat)\s*(mat)?\b/i,                               // bhool mat
  /\b(karna|lena|dena|jana|aana)\s+(hai|hoga|padega)\b/i,         // karna hai
  /\b\d+\s*baje\b/i,                                              // 3 baje (o'clock in Hindi)
  /\bmilna\s+(hai|hoga|padega)\b/i,                               // milna hai (need to meet)
  /\bparso\b/i,                                                   // day after tomorrow
  
  // Tamil patterns
  /\b(inru|naalai|naalaikku)\b/i,                                 // today, tomorrow (Tamil)
  /\bmarakkathe\b/i,                                              // don't forget (Tamil)
  /\b(pannu|pannunga)\s+\w+/i,                                    // do something (Tamil)
  /\bvanga\b/i,                                                   // come (Tamil)
  /\bmanikku\b/i,                                                 // at time (Tamil)
  /\bcall\s+pannu/i,                                              // call (Tamil-English)
  
  // Telugu patterns
  /\b(eeroju|repu|ninna)\b/i,                                     // today, tomorrow, yesterday (Telugu)
  /\bmarchipoku\b/i,                                              // don't forget (Telugu)
  /\bgurthu\s+(cheppu|pettuko)/i,                                 // remind (Telugu)
  /\b(ra|randi)\b/i,                                              // come (Telugu)
  /\bcall\s+cheyyi/i,                                             // call (Telugu-English)
  
  // Marathi patterns
  /\b(aaj|udya|kal)\s+(paryant|madhe)?\b/i,                       // today, tomorrow (Marathi)
  /\bvisaru\s+naka\b/i,                                           // don't forget (Marathi)
  /\bathvan\s+kara\b/i,                                           // remind (Marathi)
  /\bphone\s+kara\b/i,                                            // call (Marathi)
  
  // Bengali patterns
  /\b(aj|kal|porsu)\b/i,                                          // today, tomorrow, day after (Bengali)
  /\bbhulona\b/i,                                                 // don't forget (Bengali)
  /\bmone\s+(rekho|korao)\b/i,                                    // remind (Bengali)
  
  // Gujarati patterns
  /\b(aaje|kale|parase)\b/i,                                      // today, tomorrow, day after (Gujarati)
  /\bbhulta\s+nahi\b/i,                                           // don't forget (Gujarati)
  /\byaad\s+rakhjo\b/i,                                           // remember (Gujarati)
  
  // Duration patterns
  /for\s+\d+\s*(hour|hr|minute|min|day|week)/i,                   // for 2 hours
  /\d+\s*-\s*\d+\s*(am|pm)/i,                                     // 2-3pm
  /(from|between)\s+\d+\s*(to|and|-)\s*\d+/i,                     // from 2 to 3
];

// Patterns that MIGHT indicate events (medium confidence)
const MEDIUM_PATTERNS = [
  /\b(will|gonna|going\s+to|planning\s+to)\s+\w+/i,               // will call
  /\b(can|could|should|would)\s+you\s+\w+/i,                      // can you remind
  /\b(free|available|busy)\s+(at|on|tomorrow|today)/i,            // free tomorrow?
  /\bwhat\s+time\b/i,                                             // what time
  /\bhow\s+about\s+\d/i,                                          // how about 5pm
  /\b(same|usual)\s+(time|place)/i,                               // same time
];

// Weak signals that ALONE don't indicate events
const WEAK_KEYWORDS = [
  'ok', 'okay', 'yes', 'no', 'sure', 'maybe', 'thanks', 'thank', 'thanx', 'thx',
  'hi', 'hello', 'hey', 'bye', 'goodbye', 'good night', 'good morning',
  'lol', 'haha', 'hehe', 'lmao', 'rofl', 'xd',
  'cool', 'nice', 'great', 'awesome', 'perfect', 'fine', 'alright',
  'hmm', 'umm', 'idk', 'np', 'nvm', 'btw', 'fyi',
  'kk', 'k', 'yea', 'yeah', 'yup', 'nope', 'nah',
];

// Negative patterns (things that look like events but aren't)
const NEGATIVE_PATTERNS = [
  /^(ok|okay|yes|no|sure|maybe|thanks|hi|hello|hey|bye|lol|haha|cool|nice)\.?$/i,  // Single word responses
  /^\d+$/,                                                         // Just a number
  /^[a-z]{1,3}$/i,                                                // Very short messages
  /\b(meme|joke|funny|video|photo|pic|image|song|music)\b/i,     // Media sharing
];

/**
 * Checks if a message contains potential event signals
 * Returns a score and list of detected signals
 */
export function checkHeuristicGate(content: string): HeuristicResult {
  const normalizedContent = content.toLowerCase().trim();
  const foundSignals: string[] = [];
  let score = 0;

  // Quick reject for very short non-actionable messages
  if (normalizedContent.length < 3) {
    return { hasSignal: false, signals: [], score: 0 };
  }

  // Check for negative patterns (things that look like events but aren't)
  for (const pattern of NEGATIVE_PATTERNS) {
    if (pattern.test(normalizedContent)) {
      return { hasSignal: false, signals: ['negative_match'], score: -1 };
    }
  }

  // Check for STRONG patterns first (high confidence)
  for (const pattern of STRONG_PATTERNS) {
    if (pattern.test(normalizedContent)) {
      foundSignals.push(`strong_pattern:${pattern.source.slice(0, 30)}`);
      score += 3; // Strong pattern = high score
    }
  }

  // Check for MEDIUM patterns
  for (const pattern of MEDIUM_PATTERNS) {
    if (pattern.test(normalizedContent)) {
      foundSignals.push(`medium_pattern:${pattern.source.slice(0, 30)}`);
      score += 2;
    }
  }

  // Check keyword categories
  for (const [category, keywords] of Object.entries(SIGNAL_KEYWORDS)) {
    for (const keyword of keywords) {
      // Escape special regex characters and match word boundaries
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedKeyword}\\b`, 'i');
      
      if (regex.test(normalizedContent)) {
        foundSignals.push(`${category}:${keyword}`);
        
        // Different weights for different categories
        switch (category) {
          case 'action':
          case 'urgency':
            score += 2;
            break;
          case 'time':
          case 'event':
            score += 1.5;
            break;
          case 'items':
          case 'people':
            score += 0.5;
            break;
          default:
            score += 1;
        }
      }
    }
  }

  // Bonus for multiple category hits (more context = more likely event)
  const categoriesHit = new Set(foundSignals.map(s => s.split(':')[0]));
  if (categoriesHit.size >= 3) {
    score += 2; // Bonus for hitting 3+ categories
  }

  // Penalty for weak-only content
  const hasOnlyWeakKeywords = WEAK_KEYWORDS.some(w => 
    new RegExp(`^${w}[.!?]*$`, 'i').test(normalizedContent)
  );

  if (hasOnlyWeakKeywords) {
    score = 0;
    return { hasSignal: false, signals: ['weak_only'], score: 0 };
  }

  // Length considerations
  if (normalizedContent.length < 10 && score < 3) {
    score = Math.max(0, score - 1);
  }

  // Boost for longer, more detailed messages
  if (normalizedContent.length > 50 && score > 0) {
    score += 0.5;
  }

  const hasSignal = score >= HEURISTIC_THRESHOLD;

  logger.debug('Heuristic gate result', {
    contentLength: content.length,
    signalCount: foundSignals.length,
    categoriesHit: categoriesHit.size,
    score: Math.round(score * 10) / 10,
    hasSignal,
    topSignals: foundSignals.slice(0, 5),
  });

  return {
    hasSignal,
    signals: foundSignals,
    score: Math.round(score * 10) / 10,
  };
}

/**
 * Returns all keywords for a specific category (for testing/debugging)
 */
export function getKeywordsForCategory(category: string): string[] {
  return SIGNAL_KEYWORDS[category as keyof typeof SIGNAL_KEYWORDS] || [];
}

/**
 * Returns all patterns (for testing/debugging)
 */
export function getPatterns(): { strong: RegExp[], medium: RegExp[] } {
  return { strong: STRONG_PATTERNS, medium: MEDIUM_PATTERNS };
}

export default { checkHeuristicGate, getKeywordsForCategory, getPatterns };
