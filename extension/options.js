/**
 * Argus Chrome Extension - Options Script
 */

// Load saved settings
async function loadSettings() {
  const defaults = {
    serverUrl: 'http://localhost:3000',
    enableOverlay: true,
    enableNotifications: true,
    maxNotifications: 3,
    debounceMs: 3000,
    cooldownMinutes: 5,
  };
  
  const result = await chrome.storage.sync.get(defaults);
  
  document.getElementById('server-url').value = result.serverUrl;
  document.getElementById('enable-overlay').checked = result.enableOverlay;
  document.getElementById('enable-notifications').checked = result.enableNotifications;
  document.getElementById('max-notifications').value = result.maxNotifications;
  document.getElementById('debounce-ms').value = result.debounceMs;
  document.getElementById('cooldown-minutes').value = result.cooldownMinutes;
}

// Save settings
async function saveSettings() {
  const settings = {
    serverUrl: document.getElementById('server-url').value.trim(),
    enableOverlay: document.getElementById('enable-overlay').checked,
    enableNotifications: document.getElementById('enable-notifications').checked,
    maxNotifications: parseInt(document.getElementById('max-notifications').value) || 3,
    debounceMs: parseInt(document.getElementById('debounce-ms').value) || 3000,
    cooldownMinutes: parseInt(document.getElementById('cooldown-minutes').value) || 5,
  };
  
  await chrome.storage.sync.set(settings);
  
  // Show save confirmation
  const status = document.getElementById('save-status');
  status.textContent = 'Saved!';
  status.className = 'status status-success show';
  
  setTimeout(() => {
    status.classList.remove('show');
  }, 2000);
}

// Test server connection
async function testConnection() {
  const serverUrl = document.getElementById('server-url').value.trim();
  const button = document.getElementById('test-connection');
  const originalText = button.textContent;
  
  button.textContent = 'Testing...';
  button.disabled = true;
  
  try {
    const response = await fetch(`${serverUrl}/api/extension/status`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    
    if (response.ok) {
      const data = await response.json();
      button.textContent = '✓ Connected';
      button.className = 'btn btn-secondary';
      
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 2000);
    } else {
      throw new Error('Server returned error');
    }
  } catch (error) {
    button.textContent = '✗ Failed';
    button.className = 'btn btn-danger';
    
    setTimeout(() => {
      button.textContent = originalText;
      button.className = 'btn btn-secondary';
      button.disabled = false;
    }, 2000);
  }
}

// Clear cache
async function clearCache() {
  const button = document.getElementById('clear-cache');
  
  await chrome.storage.local.clear();
  
  button.textContent = 'Cleared!';
  setTimeout(() => {
    button.textContent = 'Clear Cache';
  }, 2000);
}

// Event listeners
document.addEventListener('DOMContentLoaded', loadSettings);
document.getElementById('save-settings').addEventListener('click', saveSettings);
document.getElementById('test-connection').addEventListener('click', testConnection);
document.getElementById('clear-cache').addEventListener('click', clearCache);
