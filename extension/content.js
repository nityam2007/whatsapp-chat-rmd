/**
 * Argus Chrome Extension - Content Script
 * 
 * Injected into monitored pages to:
 * 1. Extract additional context from page content
 * 2. Display overlay notifications for matching events
 */

// Overlay container ID
const OVERLAY_CONTAINER_ID = 'argus-overlay-container';

/**
 * Create or get the overlay container
 */
function getOverlayContainer() {
  let container = document.getElementById(OVERLAY_CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = OVERLAY_CONTAINER_ID;
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Create an event card element
 */
function createEventCard(match, index) {
  const card = document.createElement('div');
  card.className = 'argus-card';
  card.dataset.eventId = match.event.id;
  card.style.animationDelay = `${index * 100}ms`;
  
  const confidencePercent = Math.round(match.confidence * 100);
  const confidenceClass = match.confidence >= 0.8 ? 'high' : match.confidence >= 0.6 ? 'medium' : 'low';
  
  card.innerHTML = `
    <div class="argus-card-header">
      <div class="argus-icon">🔔</div>
      <div class="argus-title">Argus Reminder</div>
      <button class="argus-close" data-action="dismiss">&times;</button>
    </div>
    <div class="argus-card-body">
      <div class="argus-event-title">${escapeHtml(match.event.title)}</div>
      <div class="argus-event-meta">
        ${match.event.contact_name ? `<span class="argus-contact">👤 ${escapeHtml(match.event.contact_name)}</span>` : ''}
        ${match.event.location ? `<span class="argus-location">📍 ${escapeHtml(match.event.location)}</span>` : ''}
      </div>
      <div class="argus-match-info">
        <span class="argus-match-type">${getMatchTypeIcon(match.matchType)} Matched: ${escapeHtml(match.matchedValue)}</span>
        <span class="argus-confidence ${confidenceClass}">${confidencePercent}%</span>
      </div>
    </div>
    <div class="argus-card-actions">
      <button class="argus-btn argus-btn-complete" data-action="complete">✓ Got it</button>
      <button class="argus-btn argus-btn-snooze" data-action="snooze">⏰ Later</button>
      <button class="argus-btn argus-btn-dismiss" data-action="dismiss">✕ Dismiss</button>
    </div>
  `;
  
  // Add event listeners
  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => handleCardAction(e, match.event.id, card));
  });
  
  // Auto-dismiss after 30 seconds
  setTimeout(() => {
    if (card.parentElement) {
      card.classList.add('argus-card-exit');
      setTimeout(() => card.remove(), 300);
    }
  }, 30000);
  
  return card;
}

/**
 * Get icon for match type
 */
function getMatchTypeIcon(matchType) {
  switch (matchType) {
    case 'location': return '📍';
    case 'keyword': return '🔑';
    case 'context_tag': return '🏷️';
    default: return '💡';
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

/**
 * Handle card action button clicks
 */
async function handleCardAction(event, eventId, card) {
  event.preventDefault();
  const action = event.target.dataset.action;
  
  // Visual feedback
  card.classList.add('argus-card-processing');
  
  try {
    const serverUrl = 'http://localhost:3000';
    
    switch (action) {
      case 'complete':
        await fetch(`${serverUrl}/api/events/${eventId}/complete`, { method: 'POST' });
        card.classList.add('argus-card-success');
        break;
        
      case 'snooze':
        await fetch(`${serverUrl}/api/events/${eventId}/snooze`, { method: 'POST' });
        card.classList.add('argus-card-snoozed');
        break;
        
      case 'dismiss':
        // Just dismiss, don't update server
        break;
    }
  } catch (error) {
    console.error('Argus action failed:', error);
    card.classList.add('argus-card-error');
  }
  
  // Remove card with animation
  setTimeout(() => {
    card.classList.add('argus-card-exit');
    setTimeout(() => card.remove(), 300);
  }, 500);
}

/**
 * Display matches as overlay cards
 */
function displayMatches(matches) {
  const container = getOverlayContainer();
  
  // Clear existing cards
  container.innerHTML = '';
  
  // Add new cards
  matches.forEach((match, index) => {
    const card = createEventCard(match, index);
    container.appendChild(card);
  });
}

/**
 * Listen for messages from background script
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ARGUS_MATCHES') {
    console.log('Argus: Received matches', message.matches);
    displayMatches(message.matches);
    sendResponse({ received: true });
  }
  return true;
});

/**
 * Extract additional context from page (called by background script if needed)
 */
function extractPageContext() {
  const context = {
    url: window.location.href,
    title: document.title,
    keywords: [],
  };
  
  // Extract from meta tags
  const metaKeywords = document.querySelector('meta[name="keywords"]');
  if (metaKeywords) {
    context.keywords.push(...metaKeywords.content.split(',').map(k => k.trim().toLowerCase()));
  }
  
  // Extract from headings
  document.querySelectorAll('h1, h2').forEach(h => {
    const text = h.textContent.trim().toLowerCase();
    if (text.length > 2 && text.length < 50) {
      context.keywords.push(text);
    }
  });
  
  return context;
}

// Expose for background script
window.argusExtractContext = extractPageContext;

console.log('Argus Content Script loaded');
