/**
 * Argus Dashboard - Main Application
 * Page loaders, navigation, and initialization
 */

// Configuration
const PAGE_SIZE = 30;

// State
const currentPage = {
  events: 0,
  messages: 0,
  reminders: 0,
  llmCalls: 0,
  pipelineLogs: 0
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
  loadAllLogFiles();
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
    case 'database': loadDatabaseStats(); break;
    case 'events': loadEvents(); break;
    case 'messages': loadMessages(); break;
    case 'contacts': loadContacts(); break;
    case 'reminders': loadReminders(); break;
    case 'llm-calls': loadLLMCalls(); break;
    case 'pipeline-logs': loadPipelineLogs(); break;
    case 'metrics': loadMetrics(); break;
    case 'learning': loadLearningStats(); break;
  }
}

// ============================================
// Dashboard Page
// ============================================

async function refreshDashboard() {
  try {
    const [dash, db] = await Promise.all([
      fetchDashboardStats(),
      fetchDatabaseStats()
    ]);
    
    // Update stats
    document.getElementById('stat-total-messages').textContent = dash.messages?.total || 0;
    document.getElementById('stat-total-events').textContent = dash.events?.total || 0;
    document.getElementById('stat-pending').textContent = (dash.events?.pending || 0) + (dash.events?.pending_confirmation || 0);
    document.getElementById('stat-contacts').textContent = dash.topContacts?.length || 0;
    document.getElementById('stat-db-size').textContent = formatBytes(db.totalSize || 0);
    document.getElementById('nav-events-count').textContent = dash.events?.pending || 0;
    
    // LLM calls count
    const llmTable = db.tables?.find(t => t.name === 'llm_calls');
    document.getElementById('stat-llm-calls').textContent = llmTable?.count || 0;
    
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
    
    // DB tables
    const tablesEl = document.getElementById('db-tables-list');
    if (db.tables?.length > 0) {
      tablesEl.innerHTML = db.tables.map(t => `
        <tr><td>${t.name}</td><td class="num">${t.count.toLocaleString()}</td></tr>
      `).join('');
    }
    
  } catch (error) {
    console.error('Dashboard load failed:', error);
  }
}

// ============================================
// Database Page
// ============================================

async function loadDatabaseStats() {
  try {
    const data = await fetchDatabaseStats();
    
    // Stats cards
    const statsEl = document.getElementById('db-stats-cards');
    statsEl.innerHTML = `
      <div class="stat-card"><div class="label">Total Size</div><div class="value">${formatBytes(data.totalSize)}</div></div>
      <div class="stat-card info"><div class="label">Tables</div><div class="value">${data.tables?.length || 0}</div></div>
      <div class="stat-card success"><div class="label">Total Rows</div><div class="value">${data.tables?.reduce((s,t) => s + t.count, 0).toLocaleString() || 0}</div></div>
    `;
    
    // Full table list
    const tablesEl = document.getElementById('db-full-tables');
    tablesEl.innerHTML = data.tables?.map(t => `
      <tr>
        <td><code>${t.name}</code></td>
        <td class="num">${t.count.toLocaleString()}</td>
        <td>${t.count > 0 ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-soft">Empty</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="3">No data</td></tr>';
    
  } catch (error) {
    console.error('DB stats load failed:', error);
  }
}

async function cleanupTestData() {
  if (!confirm('This will delete ALL test/fake/demo data including:\n- Contacts with "test", "fake", "demo", "sample" in name/ID\n- Related messages, events, and reminders\n\nContinue?')) {
    return;
  }
  
  try {
    const data = await cleanupTestDataApi();
    
    if (data.success) {
      const summary = `Cleaned up:
- ${data.deletedMessages} messages
- ${data.deletedEvents} events
- ${data.deletedContacts} contacts
- ${data.deletedReminders} reminders
- ${data.deletedPipelineLogs} pipeline logs
- ${data.deletedLLMCalls} LLM calls`;
      
      showModal('Cleanup Complete', `<pre style="font-size:14px;">${summary}</pre>`);
      loadDatabaseStats();
    } else {
      showToast(data.error || 'Cleanup failed', 'error');
    }
  } catch (error) {
    console.error('Cleanup failed:', error);
    showToast('Cleanup failed', 'error');
  }
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
          ${e.status === 'pending' || e.status === 'pending_confirmation' ? `
            <button class="btn btn-sm btn-success" onclick="handleEventAction('${e.id}','accept')">Accept</button>
            <button class="btn btn-sm btn-danger" onclick="handleEventAction('${e.id}','decline')">Decline</button>
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
  const classification = document.getElementById('messages-classification-filter').value;
  
  try {
    const data = await fetchMessages({
      offset: page * PAGE_SIZE,
      search,
      heuristicPassed: heuristic,
      classificationTypes: classification
    });
    
    const tbody = document.getElementById('messages-table');
    tbody.innerHTML = data.messages?.map(m => `
      <tr>
        <td style="white-space:nowrap;font-size:11px;">${formatTimestamp(m.timestamp)}</td>
        <td class="truncate-sm">${escapeHtml(m.sender?.split('@')[0] || 'Unknown')}</td>
        <td class="truncate" title="${escapeHtml(m.content)}">${escapeHtml(m.content?.substring(0, 60) || '')}</td>
        <td>${m.heuristic_passed === null ? '-' : m.heuristic_passed ? '<span class="text-success">Pass</span>' : '<span class="text-danger">Fail</span>'}</td>
        <td>${m.classification_type ? `<span class="badge badge-${m.classification_type === 'irrelevant' ? 'soft' : 'classification'}">${m.classification_type}</span>` : '-'}</td>
        <td>${m.extraction_event_id ? '<span class="text-success">Yes</span>' : '-'}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-state">No messages found</td></tr>';
    
    renderPagination('messages-pagination', data.total, page, 'loadMessages');
  } catch (error) {
    console.error('Messages load failed:', error);
  }
}

// ============================================
// Contacts Page
// ============================================

async function loadContacts() {
  try {
    const data = await fetchContacts();
    
    let contacts = data.contacts || [];
    
    // Apply filters
    const filterType = document.getElementById('contacts-filter').value;
    const searchTerm = document.getElementById('contacts-search').value.toLowerCase();
    
    if (filterType === 'users') {
      contacts = contacts.filter(c => !c.is_group);
    } else if (filterType === 'groups') {
      contacts = contacts.filter(c => c.is_group);
    }
    
    if (searchTerm) {
      contacts = contacts.filter(c => 
        c.name?.toLowerCase().includes(searchTerm) || 
        c.phone?.toLowerCase().includes(searchTerm)
      );
    }
    
    // Calculate stats
    const totalContacts = data.contacts?.length || 0;
    const totalUsers = data.contacts?.filter(c => !c.is_group).length || 0;
    const totalGroups = data.contacts?.filter(c => c.is_group).length || 0;
    const totalMessages = data.contacts?.reduce((sum, c) => sum + (c.message_count || 0), 0) || 0;
    
    document.getElementById('contacts-stats').innerHTML = 
      `Total: ${totalContacts} contacts (${totalUsers} users, ${totalGroups} groups) | ${totalMessages.toLocaleString()} messages tracked | Showing: ${contacts.length}`;
    
    const tbody = document.getElementById('contacts-table');
    tbody.innerHTML = contacts.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td class="mono" style="font-size:12px;">${formatPhoneNumber(c.phone)}</td>
        <td>${c.is_group ? '<span class="badge badge-info">Group</span>' : '<span class="badge badge-soft">User</span>'}</td>
        <td class="num"><strong>${c.message_count}</strong></td>
        <td style="font-size:11px;white-space:nowrap;">${formatDate(c.last_seen)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="viewContactEvents('${escapeHtml(c.name)}')" title="View events">Events</button>
          <button class="btn btn-sm btn-danger" onclick="deleteContact('${escapeHtml(c.id)}', '${escapeHtml(c.name)}')" title="Delete contact and data">Delete</button>
        </td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-state">No contacts</td></tr>';
  } catch (error) {
    console.error('Contacts load failed:', error);
  }
}

async function viewContactEvents(name) {
  try {
    const data = await fetchContactEvents(name);
    
    let content = `<h3>Events for: ${escapeHtml(name)}</h3>`;
    if (data.events && data.events.length > 0) {
      content += `<p>Found ${data.events.length} events:</p>`;
      content += '<table style="width:100%;font-size:13px;"><thead><tr><th>Title</th><th>Date/Time</th><th>Status</th></tr></thead><tbody>';
      data.events.forEach(e => {
        content += `<tr>
          <td>${escapeHtml(e.title)}</td>
          <td style="white-space:nowrap;">${e.datetime_ist || e.datetime || '-'}</td>
          <td><span class="badge badge-${e.status === 'active' ? 'success' : e.status === 'declined' ? 'danger' : 'soft'}">${e.status}</span></td>
        </tr>`;
      });
      content += '</tbody></table>';
    } else {
      content += '<p class="empty-state">No events found for this contact.</p>';
    }
    
    showModal('Contact Events', content);
  } catch (error) {
    console.error('Failed to load contact events:', error);
    showToast('Failed to load events', 'error');
  }
}

async function deleteContact(contactId, contactName) {
  if (!confirm(`Are you sure you want to delete "${contactName}" and all related messages, events, and reminders?`)) {
    return;
  }
  
  try {
    const data = await deleteContactById(contactId);
    
    if (data.success) {
      showToast(`Deleted: ${data.deletedMessages} messages, ${data.deletedEvents} events, ${data.deletedReminders} reminders`, 'success');
      loadContacts();
    } else {
      showToast(data.error || 'Failed to delete contact', 'error');
    }
  } catch (error) {
    console.error('Failed to delete contact:', error);
    showToast('Failed to delete contact', 'error');
  }
}

// ============================================
// Reminders Page
// ============================================

async function loadReminders(page = 0) {
  currentPage.reminders = page;
  const sent = document.getElementById('reminders-filter').value;
  
  try {
    const data = await fetchReminders({
      offset: page * PAGE_SIZE,
      sent
    });
    
    const tbody = document.getElementById('reminders-table');
    tbody.innerHTML = data.reminders?.map(r => `
      <tr>
        <td class="mono truncate-sm" title="${r.id}">${r.id?.substring(0, 12)}...</td>
        <td class="truncate">${escapeHtml(r.event_title || r.event_id)}</td>
        <td style="white-space:nowrap;">${r.trigger_time_ist || r.trigger_time}</td>
        <td>${r.sent ? '<span class="badge badge-success">Sent</span>' : '<span class="badge badge-warning">Pending</span>'}</td>
        <td style="font-size:11px;">${formatDate(r.created_at)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty-state">No reminders</td></tr>';
    
    renderPagination('reminders-pagination', data.total, page, 'loadReminders');
  } catch (error) {
    console.error('Reminders load failed:', error);
  }
}

// ============================================
// LLM Calls Page
// ============================================

async function loadLLMCalls(page = 0) {
  currentPage.llmCalls = page;
  const type = document.getElementById('llm-type-filter').value;
  const success = document.getElementById('llm-success-filter').value;
  
  try {
    const data = await fetchLLMCalls({
      offset: page * PAGE_SIZE,
      type,
      success
    });
    
    const tbody = document.getElementById('llm-calls-table');
    tbody.innerHTML = data.calls?.map(c => `
      <tr>
        <td style="white-space:nowrap;font-size:11px;">${formatDate(c.created_at)}</td>
        <td><span class="badge badge-${c.call_type}">${c.call_type}</span></td>
        <td class="truncate-sm">${c.model}</td>
        <td class="num">${c.tokens_total || 0}</td>
        <td class="num">${c.duration_ms || 0}ms</td>
        <td>${c.success ? '<span class="text-success">OK</span>' : '<span class="text-danger">Fail</span>'}</td>
        <td><button class="btn btn-sm btn-outline" onclick="viewLLMCall('${c.id}')">View</button></td>
      </tr>
    `).join('') || '<tr><td colspan="7" class="empty-state">No LLM calls</td></tr>';
    
    renderPagination('llm-calls-pagination', data.total, page, 'loadLLMCalls');
  } catch (error) {
    console.error('LLM calls load failed:', error);
  }
}

function viewLLMCall(id) {
  showModal('LLM Call Details', `<p>Call ID: ${id}</p><p class="text-muted">Full details would be shown here including prompt and response.</p>`);
}

// ============================================
// Pipeline Logs Page
// ============================================

async function loadPipelineLogs(page = 0) {
  currentPage.pipelineLogs = page;
  const stage = document.getElementById('pipeline-stage-filter').value;
  
  try {
    const data = await fetchPipelineLogs({
      offset: page * PAGE_SIZE,
      stage
    });
    
    const tbody = document.getElementById('pipeline-logs-table');
    tbody.innerHTML = data.logs?.map(l => `
      <tr>
        <td style="white-space:nowrap;font-size:11px;">${formatDate(l.created_at)}</td>
        <td class="mono truncate-sm" title="${l.message_id}">${l.message_id?.substring(0, 12)}...</td>
        <td><span class="badge badge-${l.stage}">${l.stage}</span></td>
        <td>${l.status === 'success' || l.status === 'passed' ? '<span class="text-success">OK</span>' : l.status === 'error' || l.status === 'failed' ? '<span class="text-danger">Fail</span>' : l.status}</td>
        <td class="num">${l.duration_ms || '-'}</td>
        <td>${l.data ? '<button class="btn btn-sm btn-outline" onclick="viewPipelineData(this)" data-json=\'' + escapeAttr(JSON.stringify(l.data)) + '\'>View</button>' : '-'}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-state">No pipeline logs</td></tr>';
    
    renderPagination('pipeline-logs-pagination', data.total, page, 'loadPipelineLogs');
  } catch (error) {
    console.error('Pipeline logs load failed:', error);
  }
}

function viewPipelineData(btn) {
  const data = JSON.parse(btn.dataset.json);
  showModal('Pipeline Data', `<div class="code-block">${escapeHtml(JSON.stringify(data, null, 2))}</div>`);
}

// ============================================
// Metrics Page
// ============================================

async function loadMetrics() {
  try {
    const data = await fetchMetrics();
    const s = data.summary || {};
    
    const statsEl = document.getElementById('metrics-stats');
    statsEl.innerHTML = `
      <div class="stat-card"><div class="label">Uptime</div><div class="value">${s.uptimeHours || 0}h</div></div>
      <div class="stat-card success"><div class="label">Messages</div><div class="value">${s.messagesProcessed || 0}</div></div>
      <div class="stat-card info"><div class="label">Events</div><div class="value">${s.eventsCreated || 0}</div></div>
      <div class="stat-card warning"><div class="label">Avg Latency</div><div class="value">${s.avgLatencyMs || 0}ms</div></div>
      <div class="stat-card danger"><div class="label">Errors</div><div class="value">${s.errors || 0}</div></div>
    `;
    
    const detailEl = document.getElementById('metrics-detail');
    detailEl.innerHTML = Object.entries(s).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  } catch (error) {
    console.error('Metrics load failed:', error);
  }
}

// ============================================
// Log Files Page
// ============================================

async function loadAllLogFiles() {
  try {
    const data = await fetchLogFilesList();
    
    const select = document.getElementById('log-file-select');
    select.innerHTML = '<option value="">Select log file...</option>' + 
      data.logs?.map(l => `<option value="${l.path}">${l.name} (${formatBytes(l.size)})</option>`).join('');
  } catch (error) {
    console.error('Log files list failed:', error);
  }
}

async function loadLogFile() {
  const path = document.getElementById('log-file-select').value;
  const lines = document.getElementById('log-lines').value || 100;
  
  if (!path) return;
  
  try {
    const data = await fetchLogFile(path, lines);
    
    document.getElementById('log-file-name').textContent = path;
    document.getElementById('log-file-info').textContent = `${data.count || 0} lines`;
    
    const viewer = document.getElementById('log-viewer');
    const entries = data.entries || [];
    viewer.innerHTML = entries.length > 0 
      ? entries.map(e => `<div class="log-entry">${escapeHtml(e)}</div>`).join('')
      : '<div class="empty-state"><p>Log file is empty</p></div>';
    
    // Scroll to bottom
    viewer.scrollTop = viewer.scrollHeight;
  } catch (error) {
    console.error('Log file load failed:', error);
    showToast('Failed to load log file', 'error');
  }
}

// ============================================
// Pattern Learning Page
// ============================================

async function loadLearningStats() {
  try {
    const [stats, patterns] = await Promise.all([
      fetchLearningStats(),
      fetchPatterns()
    ]);
    
    const statsEl = document.getElementById('learning-stats');
    statsEl.innerHTML = `
      <div class="stat-card"><div class="label">Total Patterns</div><div class="value">${patterns.count || 0}</div></div>
      <div class="stat-card success"><div class="label">Active</div><div class="value">${patterns.patterns?.filter(p => p.is_active).length || 0}</div></div>
      <div class="stat-card info"><div class="label">Loaded in Engine</div><div class="value">${stats.loadedPatterns?.total || 0}</div></div>
    `;
    
    const tbody = document.getElementById('patterns-table');
    tbody.innerHTML = patterns.patterns?.map(p => `
      <tr>
        <td>${p.pattern_type}</td>
        <td class="mono truncate" title="${escapeHtml(p.regex_pattern)}">${escapeHtml(p.regex_pattern?.substring(0, 40) || '')}...</td>
        <td class="num">${p.hit_count || 0}</td>
        <td class="num">${Math.round((p.accuracy || 0) * 100)}%</td>
        <td>${p.is_active ? '<span class="text-success">Yes</span>' : '<span class="text-danger">No</span>'}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty-state">No patterns learned yet</td></tr>';
  } catch (error) {
    console.error('Learning stats load failed:', error);
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
