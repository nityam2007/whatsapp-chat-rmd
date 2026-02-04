/**
 * Argus Dashboard - API Client
 * All API calls and data fetching functions
 */

// API Configuration
const API_URL = '';

/**
 * Generic API call wrapper with error handling
 * @param {string} endpoint - API endpoint (without base URL)
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Response data
 */
async function apiCall(endpoint, options = {}) {
  try {
    const response = await fetch(`${API_URL}${endpoint}`, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error(`API call failed: ${endpoint}`, error);
    throw error;
  }
}

/**
 * Build query string from parameters object
 * @param {Object} params - Parameters object
 * @returns {string} Query string
 */
function buildQueryString(params) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      searchParams.append(key, value);
    }
  });
  return searchParams.toString();
}

// ============================================
// Dashboard APIs
// ============================================

/**
 * Fetch dashboard statistics
 */
async function fetchDashboardStats() {
  return apiCall('/api/dashboard/stats');
}


// ============================================
// Events APIs
// ============================================

/**
 * Fetch events with filtering and pagination
 * @param {Object} params - Query parameters
 */
async function fetchEvents(params = {}) {
  const query = buildQueryString({
    limit: params.limit || PAGE_SIZE,
    offset: params.offset || 0,
    search: params.search,
    status: params.status
  });
  return apiCall(`/api/events?${query}`);
}

/**
 * Fetch single event details
 * @param {string} id - Event ID
 */
async function fetchEvent(id) {
  return apiCall(`/api/events/${id}`);
}

/**
 * Accept or decline an event
 * @param {string} id - Event ID
 * @param {string} action - 'accept' or 'decline'
 */
async function eventAction(id, action) {
  return apiCall(`/api/events/${id}/${action}`, { method: 'POST' });
}

// ============================================
// Messages APIs
// ============================================

/**
 * Fetch messages with filtering and pagination
 * @param {Object} params - Query parameters
 */
async function fetchMessages(params = {}) {
  const query = buildQueryString({
    limit: params.limit || PAGE_SIZE,
    offset: params.offset || 0,
    search: params.search,
    heuristicPassed: params.heuristicPassed
  });
  return apiCall(`/api/messages/detailed?${query}`);
}

// ============================================
// Contacts APIs
// ============================================

// ============================================
// Push Notifications APIs
// ============================================

/**
 * Fetch VAPID public key
 */
async function fetchVapidPublicKey() {
  return apiCall('/api/vapid-public-key');
}

/**
 * Subscribe to push notifications
 * @param {Object} subscription - Push subscription object
 */
async function subscribeToNotifications(subscription) {
  return apiCall('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription)
  });
}

/**
 * Unsubscribe from push notifications
 * @param {string} endpoint - Subscription endpoint
 */
async function unsubscribeFromNotifications(endpoint) {
  return apiCall('/api/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint })
  });
}

/**
 * Send test notification
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 */
async function sendTestNotification(title = 'Test', body = 'Test notification from Argus') {
  return apiCall('/api/test-notification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body })
  });
}

/**
 * Fetch RMD push status (subscription count in main server)
 */
async function fetchRmdPushStatus() {
  return apiCall('/api/rmd-push-status');
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    API_URL,
    apiCall,
    buildQueryString,
    fetchDashboardStats,
    fetchEvents,
    fetchEvent,
    eventAction,
    fetchMessages,
    fetchVapidPublicKey,
    subscribeToNotifications,
    unsubscribeFromNotifications,
    sendTestNotification,
    fetchRmdPushStatus
  };
}
