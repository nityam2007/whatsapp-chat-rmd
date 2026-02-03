/**
 * Argus Dashboard - Utility Functions
 * Common helper functions used throughout the application
 */

/**
 * Escape HTML to prevent XSS attacks
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML string
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape attribute value for safe embedding in HTML attributes
 * @param {string} text - Text to escape
 * @returns {string} Escaped attribute string
 */
function escapeAttr(text) {
  return text.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

/**
 * Format date string for display in IST timezone
 * @param {string} dateStr - Date string or ISO date
 * @returns {string} Formatted date string
 */
function formatDate(dateStr) {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return date.toLocaleString('en-IN', { 
      timeZone: 'Asia/Kolkata', 
      dateStyle: 'short', 
      timeStyle: 'short' 
    });
  } catch { 
    return dateStr; 
  }
}

/**
 * Format Unix timestamp to readable date
 * @param {number} ts - Unix timestamp in seconds
 * @returns {string} Formatted date string
 */
function formatTimestamp(ts) {
  if (!ts) return '-';
  return formatDate(new Date(ts * 1000));
}

/**
 * Format bytes to human readable size
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string (e.g., "1.5 MB")
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Format phone number for display
 * Converts raw numbers like 919664833459 to +91 96648 33459
 * @param {string} phone - Phone number string
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(phone) {
  if (!phone) return '-';
  // If it looks like a test chat ID, return as-is
  if (phone.includes('test') || phone.includes('-') || !phone.match(/^\d+$/)) {
    return phone;
  }
  // Format Indian numbers: +91 XXXXX XXXXX
  if (phone.startsWith('91') && phone.length >= 12) {
    return `+91 ${phone.substring(2, 7)} ${phone.substring(7)}`;
  }
  // Generic formatting: +XX XXX XXX XXXX
  if (phone.length >= 10) {
    return `+${phone.substring(0, 2)} ${phone.substring(2, 5)} ${phone.substring(5, 8)} ${phone.substring(8)}`;
  }
  return phone;
}

/**
 * Convert URL-safe base64 to Uint8Array (for VAPID keys)
 * @param {string} base64String - URL-safe base64 string
 * @returns {Uint8Array} Converted array
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Show modal dialog with content
 * @param {string} title - Modal title
 * @param {string} content - Modal body HTML content
 */
function showModal(title, content) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = content;
  document.getElementById('modal').classList.remove('hidden');
}

/**
 * Close the modal dialog
 */
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}

/**
 * Show toast notification
 * @param {string} message - Message to display
 * @param {string} type - Toast type: 'success', 'error', 'warning', 'info'
 */
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

/**
 * Render pagination controls
 * @param {string} elementId - Target element ID
 * @param {number} total - Total items count
 * @param {number} currentPage - Current page (0-indexed)
 * @param {string} loadFnName - Function name to call for loading pages
 */
function renderPagination(elementId, total, currentPage, loadFnName) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const el = document.getElementById(elementId);
  
  if (totalPages <= 1) { 
    el.innerHTML = ''; 
    return; 
  }
  
  let html = '';
  if (currentPage > 0) {
    html += `<button class="btn btn-sm btn-outline" onclick="${loadFnName}(${currentPage - 1})">Prev</button>`;
  }
  html += `<span class="pagination-info">Page ${currentPage + 1} of ${totalPages} (${total} total)</span>`;
  if (currentPage < totalPages - 1) {
    html += `<button class="btn btn-sm btn-outline" onclick="${loadFnName}(${currentPage + 1})">Next</button>`;
  }
  el.innerHTML = html;
}

// Export for module usage (if using ES modules in future)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    escapeHtml,
    escapeAttr,
    formatDate,
    formatTimestamp,
    formatBytes,
    formatPhoneNumber,
    urlBase64ToUint8Array,
    showModal,
    closeModal,
    showToast,
    renderPagination
  };
}
