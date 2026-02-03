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

/**
 * Fetch database statistics
 */
async function fetchDatabaseStats() {
  return apiCall('/api/db/stats');
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
    heuristicPassed: params.heuristicPassed,
    classificationTypes: params.classificationTypes
  });
  return apiCall(`/api/messages/detailed?${query}`);
}

// ============================================
// Contacts APIs
// ============================================

/**
 * Fetch all contacts
 */
async function fetchContacts() {
  return apiCall('/api/contacts');
}

/**
 * Fetch events for a specific contact
 * @param {string} name - Contact name
 */
async function fetchContactEvents(name) {
  return apiCall(`/api/contacts/${encodeURIComponent(name)}/events`);
}

/**
 * Delete a contact and all related data
 * @param {string} id - Contact ID
 */
async function deleteContactById(id) {
  return apiCall(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ============================================
// Reminders APIs
// ============================================

/**
 * Fetch reminders with filtering and pagination
 * @param {Object} params - Query parameters
 */
async function fetchReminders(params = {}) {
  const query = buildQueryString({
    limit: params.limit || PAGE_SIZE,
    offset: params.offset || 0,
    sent: params.sent
  });
  return apiCall(`/api/reminders?${query}`);
}

// ============================================
// LLM Calls APIs
// ============================================

/**
 * Fetch LLM calls with filtering and pagination
 * @param {Object} params - Query parameters
 */
async function fetchLLMCalls(params = {}) {
  const query = buildQueryString({
    limit: params.limit || PAGE_SIZE,
    offset: params.offset || 0,
    type: params.type,
    success: params.success
  });
  return apiCall(`/api/llm-calls?${query}`);
}

// ============================================
// Pipeline Logs APIs
// ============================================

/**
 * Fetch pipeline logs with filtering and pagination
 * @param {Object} params - Query parameters
 */
async function fetchPipelineLogs(params = {}) {
  const query = buildQueryString({
    limit: params.limit || PAGE_SIZE,
    offset: params.offset || 0,
    stage: params.stage
  });
  return apiCall(`/api/pipeline-logs?${query}`);
}

// ============================================
// Metrics APIs
// ============================================

/**
 * Fetch metrics summary
 */
async function fetchMetrics() {
  return apiCall('/api/metrics/summary');
}

// ============================================
// Log Files APIs
// ============================================

/**
 * Fetch list of all log files
 */
async function fetchLogFilesList() {
  return apiCall('/api/logs/all');
}

/**
 * Fetch content of a specific log file
 * @param {string} path - Log file path
 * @param {number} lines - Number of lines to fetch
 */
async function fetchLogFile(path, lines = 100) {
  let url;
  if (path.startsWith('logs/pipeline/')) {
    const step = path.replace('logs/pipeline/', '').replace('.log', '');
    url = `/api/logs/${step}?lines=${lines}`;
  } else if (path.startsWith('logs/')) {
    const filename = path.replace('logs/', '');
    url = `/api/logs/file/${filename}?lines=${lines}`;
  } else {
    throw new Error('Unsupported log path');
  }
  return apiCall(url);
}

// ============================================
// Pattern Learning APIs
// ============================================

/**
 * Fetch learning statistics
 */
async function fetchLearningStats() {
  return apiCall('/api/learning/stats');
}

/**
 * Fetch learned patterns
 */
async function fetchPatterns() {
  return apiCall('/api/learning/patterns');
}

// ============================================
// Cleanup APIs
// ============================================

/**
 * Clean up test/demo data
 */
async function cleanupTestDataApi() {
  return apiCall('/api/cleanup/test-data', { method: 'POST' });
}

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
    fetchDatabaseStats,
    fetchEvents,
    fetchEvent,
    eventAction,
    fetchMessages,
    fetchContacts,
    fetchContactEvents,
    deleteContactById,
    fetchReminders,
    fetchLLMCalls,
    fetchPipelineLogs,
    fetchMetrics,
    fetchLogFilesList,
    fetchLogFile,
    fetchLearningStats,
    fetchPatterns,
    cleanupTestDataApi,
    fetchVapidPublicKey,
    subscribeToNotifications,
    unsubscribeFromNotifications,
    sendTestNotification,
    fetchRmdPushStatus
  };
}
