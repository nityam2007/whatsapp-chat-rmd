/**
 * Argus Dashboard - Main Application
 * Page loaders, navigation, and initialization
 */

// Configuration
const PAGE_SIZE = 30;

// State
const currentPage = {
  events: 0,
  messages: 0
};

// Push notifications state
let swRegistration = null;
let subscription = null;

// ============================================
// Initialization
// ============================================

window.addEventListener('load', async () => {
  // Set up navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => showPage(item.dataset.page));
  });
  
  // Load initial data
  refreshDashboard();
  checkNotificationStatus();
});

// ============================================
// Navigation
// ============================================

function showPage(page) {
  // Update page visibility
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  
  // Load page data
  switch(page) {
    case 'dashboard': refreshDashboard(); break;
    case 'events': loadEvents(); break;
    case 'messages': loadMessages(); break;
  }
}

// ============================================
// Dashboard Page
// ============================================

async function refreshDashboard() {
  try {
    const dash = await fetchDashboardStats();
    
    // Update stats
    document.getElementById('stat-total-messages').textContent = dash.messages?.total || 0;
    document.getElementById('stat-total-events').textContent = dash.events?.total || 0;
    document.getElementById('stat-pending').textContent = dash.events?.pending || 0;
    document.getElementById('nav-events-count').textContent = dash.events?.pending || 0;
    
    // Last updated
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString();
    
    // Upcoming events
    const upcomingEl = document.getElementById('upcoming-events');
    if (dash.upcoming?.length > 0) {
      upcomingEl.innerHTML = dash.upcoming.map(e => `
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);">
          <div style="font-weight:500;">${escapeHtml(e.title || 'Untitled')}</div>
          <div style="font-size:12px;color:var(--text-muted);">
            ${e.contact_name || 'Unknown'} &middot; ${formatDate(e.start_time_ist || e.start_time)}
          </div>
        </div>
      `).join('');
    } else {
      upcomingEl.innerHTML = '<div class="empty-state"><p>No upcoming events</p></div>';
    }
    
  } catch (error) {
    console.error('Dashboard load failed:', error);
  }
}

function runQuickSearch() {
  const input = document.getElementById('quick-search');
  if (!input) return;
  const query = input.value.trim();
  showPage('messages');
  const searchEl = document.getElementById('messages-search');
  if (searchEl) {
    searchEl.value = query;
  }
  loadMessages(0);
}

// ============================================
// Events Page
// ============================================

async function loadEvents(page = 0) {
  currentPage.events = page;
  const search = document.getElementById('events-search').value;
  const status = document.getElementById('events-filter').value;
  
  try {
    const data = await fetchEvents({
      offset: page * PAGE_SIZE,
      search,
      status
    });
    
    const tbody = document.getElementById('events-table');
    tbody.innerHTML = data.events?.map(e => `
      <tr>
        <td class="truncate" title="${escapeHtml(e.title || '')}">${escapeHtml(e.title || 'Untitled')}</td>
        <td class="truncate-sm">${escapeHtml(e.contact_name || 'Unknown')}</td>
        <td style="white-space:nowrap;">${formatDate(e.start_time_ist || e.start_time)}</td>
        <td><span class="badge badge-${e.status}">${e.status}</span></td>
        <td class="num">${Math.round((e.confidence || 0) * 100)}%</td>
        <td>
          ${e.status === 'pending' ? `
            <button class="btn btn-sm btn-success" onclick="handleEventAction('${e.id}','accept')">Accept</button>
            <button class="btn btn-sm btn-danger" onclick="handleEventAction('${e.id}','decline')">Decline</button>
          ` : ''}
          ${e.status === 'active' ? `
            <button class="btn btn-sm btn-success" onclick="handleEventAction('${e.id}','complete')">Complete</button>
          ` : ''}
          <button class="btn btn-sm btn-outline" onclick="viewEventDetail('${e.id}')">View</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-state">No events found</td></tr>';
    
    renderPagination('events-pagination', data.total, page, 'loadEvents');
  } catch (error) {
    console.error('Events load failed:', error);
  }
}

async function handleEventAction(id, action) {
  try {
    await eventAction(id, action);
    showToast(`Event ${action}ed`, 'success');
    loadEvents(currentPage.events);
    refreshDashboard();
  } catch (error) {
    showToast('Action failed', 'error');
  }
}

async function viewEventDetail(id) {
  try {
    const data = await fetchEvent(id);
    const e = data.event;
    
    showModal('Event Details', `
      <table style="width:100%;">
        <tr><td style="width:120px;color:var(--text-muted);">Title</td><td>${escapeHtml(e.title || 'Untitled')}</td></tr>
        <tr><td style="color:var(--text-muted);">Status</td><td><span class="badge badge-${e.status}">${e.status}</span></td></tr>
        <tr><td style="color:var(--text-muted);">Contact</td><td>${escapeHtml(e.contact_name || 'Unknown')}</td></tr>
        <tr><td style="color:var(--text-muted);">Start Time</td><td>${e.start_time_ist || e.start_time || 'Not set'}</td></tr>
        <tr><td style="color:var(--text-muted);">Confidence</td><td>${Math.round((e.confidence || 0) * 100)}%</td></tr>
        <tr><td style="color:var(--text-muted);">Created</td><td>${e.created_at}</td></tr>
        ${e.source_message_content ? `<tr><td style="color:var(--text-muted);">Source</td><td><em>"${escapeHtml(e.source_message_content)}"</em></td></tr>` : ''}
      </table>
    `);
  } catch (error) {
    showToast('Failed to load event', 'error');
  }
}

// ============================================
// Messages Page
// ============================================

async function loadMessages(page = 0) {
  currentPage.messages = page;
  const search = document.getElementById('messages-search').value;
  const heuristic = document.getElementById('messages-heuristic-filter').value;
  
  try {
    const data = await fetchMessages({
      offset: page * PAGE_SIZE,
      search,
      heuristicPassed: heuristic
    });
    
    const tbody = document.getElementById('messages-table');
    tbody.innerHTML = data.messages?.map(m => `
      <tr>
        <td style="white-space:nowrap;font-size:11px;">${formatTimestamp(m.timestamp)}</td>
        <td class="truncate-sm">${escapeHtml(m.sender?.split('@')[0] || 'Unknown')}</td>
        <td class="truncate" title="${escapeHtml(m.content)}">${escapeHtml(m.content?.substring(0, 60) || '')}</td>
        <td>${m.heuristic_passed === null ? '-' : m.heuristic_passed ? '<span class="text-success">Pass</span>' : '<span class="text-danger">Fail</span>'}</td>
        <td>${m.extraction_event_id ? '<span class="text-success">Yes</span>' : '-'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty-state">No messages found</td></tr>';
    
    renderPagination('messages-pagination', data.total, page, 'loadMessages');
  } catch (error) {
    console.error('Messages load failed:', error);
  }
}


// ============================================
// Push Notifications
// ============================================

async function checkNotificationStatus() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  document.getElementById('info-support').textContent = supported ? 'Yes' : 'No';
  
  if (!supported) {
    document.getElementById('notif-icon').textContent = '[X]';
    document.getElementById('notif-text').textContent = 'Push notifications not supported';
    return;
  }
  
  document.getElementById('info-permission').textContent = Notification.permission;
  
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
    document.getElementById('info-sw').textContent = 'Registered';
    subscription = await swRegistration.pushManager.getSubscription();
    
    if (subscription) {
      document.getElementById('info-subscription').textContent = 'Active';
      document.getElementById('notif-icon').textContent = '[ON]';
      document.getElementById('notif-text').textContent = 'Notifications enabled';
      document.getElementById('btn-unsubscribe').classList.remove('hidden');
      document.getElementById('btn-test').classList.remove('hidden');
    } else {
      document.getElementById('info-subscription').textContent = 'None';
      document.getElementById('notif-icon').textContent = '[OFF]';
      document.getElementById('notif-text').textContent = 'Notifications disabled';
      document.getElementById('btn-subscribe').classList.remove('hidden');
    }
    
    // Fetch RMD server push status
    try {
      const rmdStatus = await fetchRmdPushStatus();
      const rmdSyncEl = document.getElementById('info-rmd-sync');
      if (rmdStatus.configured) {
        rmdSyncEl.innerHTML = `<span class="text-success">${rmdStatus.subscriptionCount} subscription(s) in RMD</span>`;
      } else {
        rmdSyncEl.innerHTML = '<span class="text-warning">VAPID not configured</span>';
      }
    } catch (e) {
      document.getElementById('info-rmd-sync').innerHTML = '<span class="text-danger">RMD not available</span>';
    }
  } catch (error) {
    document.getElementById('info-sw').textContent = 'Error: ' + error.message;
  }
}

async function subscribe() {
  try {
    const permission = await Notification.requestPermission();
    document.getElementById('info-permission').textContent = permission;
    if (permission !== 'granted') { 
      showToast('Permission denied', 'error'); 
      return; 
    }
    
    const { publicKey } = await fetchVapidPublicKey();
    if (!publicKey) { 
      showToast('VAPID key not configured', 'error'); 
      return; 
    }
    
    subscription = await swRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    
    await subscribeToNotifications(subscription);
    
    showToast('Notifications enabled', 'success');
    checkNotificationStatus();
  } catch (error) {
    showToast('Failed: ' + error.message, 'error');
  }
}

async function unsubscribe() {
  if (subscription) {
    await unsubscribeFromNotifications(subscription.endpoint);
    await subscription.unsubscribe();
  }
  showToast('Notifications disabled', 'success');
  checkNotificationStatus();
}

async function testNotification() {
  await sendTestNotification('Test', 'Test notification from Argus');
  showToast('Test notification sent', 'success');
}

async function syncSubscriptionsToServer() {
  const resultEl = document.getElementById('sync-result');
  resultEl.textContent = 'Syncing...';
  resultEl.style.color = 'var(--text-muted)';
  
  try {
    const response = await fetch('/api/sync-subscriptions', { method: 'POST' });
    const data = await response.json();
    
    if (data.success) {
      resultEl.textContent = `Synced ${data.synced}/${data.total} subscriptions`;
      resultEl.style.color = 'var(--success)';
      document.getElementById('info-rmd-sync').textContent = `Synced (${data.synced})`;
      showToast('Subscriptions synced successfully', 'success');
    } else {
      resultEl.textContent = 'Sync failed';
      resultEl.style.color = 'var(--danger)';
      showToast('Sync failed', 'error');
    }
  } catch (error) {
    resultEl.textContent = 'Error: ' + error.message;
    resultEl.style.color = 'var(--danger)';
    showToast('Sync failed: ' + error.message, 'error');
  }
}
