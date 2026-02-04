/**
 * Argus Chrome Extension - Background Service Worker
 * 
 * Monitors browser activity and triggers proactive reminders
 * by querying the Argus backend API.
 */

// Configuration
const CONFIG = {
  serverUrl: 'http://localhost:3000',
  debounceMs: 3000,        // Wait 3s after tab change before querying
  cooldownMs: 300000,      // 5 minute cooldown per site
  maxNotificationsPerPage: 3,
};

// State
let lastQueryTime = 0;
let queryCooldowns = new Map(); // site -> timestamp
let cachedEvents = [];

/**
 * Site detection rules - maps URL patterns to activity types and keywords
 */
const SITE_DETECTORS = {
  // Travel sites
  'makemytrip.com': {
    activity: 'travel_search',
    extractKeywords: (url, title) => extractTravelKeywords(url, title),
  },
  'booking.com': {
    activity: 'travel_search',
    extractKeywords: (url, title) => extractTravelKeywords(url, title),
  },
  'goibibo.com': {
    activity: 'travel_search',
    extractKeywords: (url, title) => extractTravelKeywords(url, title),
  },
  
  // Shopping sites
  'amazon.in': {
    activity: 'shopping',
    extractKeywords: (url, title) => extractShoppingKeywords(url, title),
  },
  'amazon.com': {
    activity: 'shopping',
    extractKeywords: (url, title) => extractShoppingKeywords(url, title),
  },
  'flipkart.com': {
    activity: 'shopping',
    extractKeywords: (url, title) => extractShoppingKeywords(url, title),
  },
  
  // Streaming sites
  'netflix.com': {
    activity: 'streaming',
    extractKeywords: (url, title) => ['netflix', 'subscription', 'streaming'],
  },
  'primevideo.com': {
    activity: 'streaming',
    extractKeywords: (url, title) => ['prime', 'amazon', 'subscription', 'streaming'],
  },
  'hotstar.com': {
    activity: 'streaming',
    extractKeywords: (url, title) => ['hotstar', 'subscription', 'streaming'],
  },
  
  // Maps
  'google.com/maps': {
    activity: 'navigation',
    extractKeywords: (url, title) => extractLocationFromMaps(url, title),
  },
  'maps.google.com': {
    activity: 'navigation',
    extractKeywords: (url, title) => extractLocationFromMaps(url, title),
  },
};

/**
 * Extract travel-related keywords from URL and title
 */
function extractTravelKeywords(url, title) {
  const keywords = [];
  const combined = `${url} ${title}`.toLowerCase();
  
  // Common Indian travel destinations
  const destinations = [
    'goa', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'hyderabad',
    'jaipur', 'udaipur', 'manali', 'shimla', 'ladakh', 'kerala', 'ooty',
    'rishikesh', 'varanasi', 'agra', 'darjeeling', 'andaman', 'lakshadweep',
    'kashmir', 'sikkim', 'meghalaya', 'dubai', 'singapore', 'thailand', 'bali',
  ];
  
  for (const dest of destinations) {
    if (combined.includes(dest)) {
      keywords.push(dest);
    }
  }
  
  // URL parameter extraction
  const urlParams = new URLSearchParams(url.split('?')[1] || '');
  const destination = urlParams.get('destination') || urlParams.get('dest') || urlParams.get('to');
  if (destination) {
    keywords.push(destination.toLowerCase());
  }
  
  // Add generic travel keywords
  if (combined.includes('flight')) keywords.push('flight');
  if (combined.includes('hotel')) keywords.push('hotel');
  if (combined.includes('holiday')) keywords.push('holiday');
  if (combined.includes('vacation')) keywords.push('vacation');
  
  return [...new Set(keywords)];
}

/**
 * Extract shopping-related keywords
 */
function extractShoppingKeywords(url, title) {
  const keywords = [];
  const combined = `${url} ${title}`.toLowerCase();
  
  // Product categories
  const categories = [
    'shoes', 'sneakers', 'watch', 'phone', 'laptop', 'camera', 'headphones',
    'gift', 'birthday', 'anniversary', 'wedding', 'clothes', 'dress', 'shirt',
    'electronics', 'appliances', 'furniture', 'books', 'toys',
  ];
  
  for (const cat of categories) {
    if (combined.includes(cat)) {
      keywords.push(cat);
    }
  }
  
  // Check for sale/discount
  if (combined.includes('sale') || combined.includes('discount') || combined.includes('offer')) {
    keywords.push('sale');
  }
  
  return [...new Set(keywords)];
}

/**
 * Extract location from Google Maps
 */
function extractLocationFromMaps(url, title) {
  const keywords = [];
  
  try {
    // Extract from URL path
    const match = url.match(/place\/([^\/]+)/);
    if (match) {
      const place = decodeURIComponent(match[1]).replace(/\+/g, ' ').toLowerCase();
      keywords.push(place);
    }
    
    // Extract from search query
    const urlParams = new URLSearchParams(url.split('?')[1] || '');
    const query = urlParams.get('q');
    if (query) {
      keywords.push(query.toLowerCase());
    }
  } catch (e) {
    console.error('Error extracting location:', e);
  }
  
  return keywords;
}

/**
 * Detect site type and extract context
 */
function detectSiteContext(url, title) {
  const urlLower = url.toLowerCase();
  
  for (const [pattern, detector] of Object.entries(SITE_DETECTORS)) {
    if (urlLower.includes(pattern)) {
      return {
        activity: detector.activity,
        keywords: detector.extractKeywords(url, title),
        site: pattern,
      };
    }
  }
  
  return null;
}

/**
 * Query Argus backend for matching events
 */
async function queryBackend(context) {
  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/extension/context`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: context.url,
        pageTitle: context.title,
        keywords: context.keywords,
        location: context.keywords.find(k => k.length > 2) || null,
        activity: context.activity,
      }),
    });
    
    if (!response.ok) {
      console.error('Argus API error:', response.status);
      return [];
    }
    
    const data = await response.json();
    return data.matches || [];
  } catch (error) {
    console.error('Failed to query Argus:', error);
    return [];
  }
}

/**
 * Show notification for matching events
 */
async function showNotification(match) {
  const notificationId = `argus-${match.event.id}-${Date.now()}`;
  
  await chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: '🔔 Argus Reminder',
    message: match.event.title,
    contextMessage: `Matched: ${match.matchedValue} (${Math.round(match.confidence * 100)}% confidence)`,
    priority: 2,
    buttons: [
      { title: '✓ Got it' },
      { title: '⏰ Snooze' },
    ],
  });
  
  // Store notification data for button handling
  await chrome.storage.local.set({
    [`notification-${notificationId}`]: {
      eventId: match.event.id,
      timestamp: Date.now(),
    },
  });
}

/**
 * Send matched events to content script for overlay display
 */
async function sendToContentScript(tabId, matches) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'ARGUS_MATCHES',
      matches: matches.slice(0, CONFIG.maxNotificationsPerPage),
    });
  } catch (error) {
    // Content script not ready, use notification fallback
    console.log('Content script not ready, using notifications');
    for (const match of matches.slice(0, CONFIG.maxNotificationsPerPage)) {
      await showNotification(match);
    }
  }
}

/**
 * Handle tab activation/update
 */
async function handleTabChange(tab) {
  if (!tab.url || !tab.url.startsWith('http')) return;
  
  // Debounce
  const now = Date.now();
  if (now - lastQueryTime < CONFIG.debounceMs) return;
  
  // Check cooldown for this site
  const context = detectSiteContext(tab.url, tab.title || '');
  if (!context) return;
  
  const cooldownKey = context.site;
  const lastQuery = queryCooldowns.get(cooldownKey) || 0;
  if (now - lastQuery < CONFIG.cooldownMs) {
    console.log(`Cooldown active for ${cooldownKey}`);
    return;
  }
  
  // Update timestamps
  lastQueryTime = now;
  queryCooldowns.set(cooldownKey, now);
  
  console.log('Argus context detected:', context);
  
  // Query backend
  const matches = await queryBackend({
    url: tab.url,
    title: tab.title,
    ...context,
  });
  
  if (matches.length > 0) {
    console.log('Argus matches found:', matches.length);
    await sendToContentScript(tab.id, matches);
  }
}

// Event listeners
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  await handleTabChange(tab);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    await handleTabChange(tab);
  }
});

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const data = await chrome.storage.local.get(`notification-${notificationId}`);
  const notificationData = data[`notification-${notificationId}`];
  
  if (!notificationData) return;
  
  if (buttonIndex === 0) {
    // "Got it" - mark as completed
    try {
      await fetch(`${CONFIG.serverUrl}/api/events/${notificationData.eventId}/complete`, {
        method: 'POST',
      });
    } catch (e) {
      console.error('Failed to complete event:', e);
    }
  } else if (buttonIndex === 1) {
    // "Snooze" - snooze the event
    try {
      await fetch(`${CONFIG.serverUrl}/api/events/${notificationData.eventId}/snooze`, {
        method: 'POST',
      });
    } catch (e) {
      console.error('Failed to snooze event:', e);
    }
  }
  
  chrome.notifications.clear(notificationId);
  await chrome.storage.local.remove(`notification-${notificationId}`);
});

// Initial sync of hot events
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/extension/hot-events`);
    if (response.ok) {
      const data = await response.json();
      cachedEvents = data.events || [];
      await chrome.storage.local.set({ cachedEvents });
      console.log('Argus: Synced', cachedEvents.length, 'hot events');
    }
  } catch (e) {
    console.log('Argus: Backend not available for initial sync');
  }
});

// Periodic sync every 5 minutes
chrome.alarms.create('sync-events', { periodInMinutes: 5 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'sync-events') {
    try {
      const response = await fetch(`${CONFIG.serverUrl}/api/extension/hot-events`);
      if (response.ok) {
        const data = await response.json();
        cachedEvents = data.events || [];
        await chrome.storage.local.set({ cachedEvents });
      }
    } catch (e) {
      // Backend offline, use cached
    }
  }
});

console.log('Argus Background Service Worker initialized');
