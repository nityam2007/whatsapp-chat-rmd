/**
 * Argus Chrome Extension - Popup Script
 */

const SERVER_URL = 'http://localhost:3000';

async function loadData() {
  const statusBadge = document.getElementById('status-badge');
  const eventsList = document.getElementById('events-list');
  
  try {
    // Check connection status
    const statusResponse = await fetch(`${SERVER_URL}/api/extension/status`);
    
    if (statusResponse.ok) {
      const statusData = await statusResponse.json();
      statusBadge.textContent = 'Connected';
      statusBadge.className = 'status-badge status-connected';
      
      // Update stats
      document.getElementById('stat-hot').textContent = statusData.stats.hotEventCount;
      document.getElementById('stat-location').textContent = statusData.stats.locationBasedCount;
    } else {
      throw new Error('Server error');
    }
    
    // Load hot events
    const eventsResponse = await fetch(`${SERVER_URL}/api/extension/hot-events?limit=10`);
    
    if (eventsResponse.ok) {
      const eventsData = await eventsResponse.json();
      
      if (eventsData.events.length === 0) {
        eventsList.innerHTML = `
          <div class="empty-state">
            <div class="icon">📭</div>
            <div>No active events found</div>
            <div style="font-size: 12px; margin-top: 8px;">Events from WhatsApp will appear here</div>
          </div>
        `;
      } else {
        eventsList.innerHTML = eventsData.events.map(event => `
          <div class="event-item" data-id="${event.id}">
            <div class="event-title">${escapeHtml(event.title)}</div>
            <div class="event-meta">
              ${event.location ? `<span class="event-location">📍 ${escapeHtml(event.location)}</span>` : ''}
              ${event.contact_name ? `<span>👤 ${escapeHtml(event.contact_name)}</span>` : ''}
              <span>${formatDate(event.created_at)}</span>
            </div>
          </div>
        `).join('');
        
        // Add click handlers
        eventsList.querySelectorAll('.event-item').forEach(item => {
          item.addEventListener('click', () => {
            // Open webapp to event details
            chrome.tabs.create({ url: `${SERVER_URL}/#event-${item.dataset.id}` });
          });
        });
      }
    }
    
  } catch (error) {
    console.error('Failed to load data:', error);
    
    statusBadge.textContent = 'Offline';
    statusBadge.className = 'status-badge status-disconnected';
    
    // Try loading from cache
    const cached = await chrome.storage.local.get('cachedEvents');
    const cachedEvents = cached.cachedEvents || [];
    
    if (cachedEvents.length > 0) {
      document.getElementById('stat-hot').textContent = cachedEvents.length;
      document.getElementById('stat-location').textContent = cachedEvents.filter(e => e.location).length;
      
      eventsList.innerHTML = `
        <div style="padding: 8px 0; font-size: 12px; color: #d69e2e; text-align: center;">
          ⚠️ Showing cached data (server offline)
        </div>
      ` + cachedEvents.slice(0, 10).map(event => `
        <div class="event-item">
          <div class="event-title">${escapeHtml(event.title)}</div>
          <div class="event-meta">
            ${event.location ? `<span class="event-location">📍 ${escapeHtml(event.location)}</span>` : ''}
          </div>
        </div>
      `).join('');
    } else {
      eventsList.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔌</div>
          <div>Cannot connect to Argus server</div>
          <div style="font-size: 12px; margin-top: 8px;">Make sure the server is running on localhost:3000</div>
        </div>
      `;
    }
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 86400000) { // Less than 1 day
    return 'Today';
  } else if (diff < 172800000) { // Less than 2 days
    return 'Yesterday';
  } else if (diff < 604800000) { // Less than 1 week
    return `${Math.floor(diff / 86400000)} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

// Load data on popup open
document.addEventListener('DOMContentLoaded', loadData);

// Refresh button
document.getElementById('refresh-btn').addEventListener('click', loadData);
