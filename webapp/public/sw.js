// Service Worker for Push Notifications
// Argus v0.8.0

const CACHE_NAME = 'argus-v1';
const API_BASE = self.location.origin;

// Install event
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Argus Service Worker...');
  self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Argus Service Worker...');
  event.waitUntil(clients.claim());
});

// Push event - receive push notification
self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event);
  
  let data = {
    title: 'Argus',
    body: 'New notification',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    type: 'general',
    data: {}
  };
  
  if (event.data) {
    try {
      const payload = event.data.json();
      data = { ...data, ...payload };
    } catch (e) {
      data.body = event.data.text();
    }
  }
  
  // Determine notification options based on type
  let options = {
    body: data.body,
    icon: data.icon || '/icon-192.svg',
    badge: data.badge || '/icon-192.svg',
    vibrate: [200, 100, 200],
    data: {
      ...data.data,
      type: data.type,
      event_id: data.event_id,
      timestamp: Date.now(),
    },
    requireInteraction: true,
    tag: data.event_id || `argus-${Date.now()}`,
  };
  
  // Set actions based on notification type
  if (data.type === 'reminder' && data.data?.requiresConfirmation) {
    // Event pending confirmation - show Accept/Decline
    options.actions = [
      { action: 'accept', title: 'Accept', icon: '/icons/check.png' },
      { action: 'decline', title: 'Decline', icon: '/icons/x.png' },
    ];
  } else if (data.type === 'reminder') {
    // Regular reminder - show Complete/Snooze
    options.actions = [
      { action: 'complete', title: 'Done', icon: '/icons/check.png' },
      { action: 'snooze', title: 'Snooze 1h', icon: '/icons/clock.png' },
    ];
  } else if (data.type === 'conflict') {
    options.actions = [
      { action: 'view', title: 'View Details' },
      { action: 'dismiss', title: 'Dismiss' },
    ];
  } else {
    options.actions = [
      { action: 'view', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' },
    ];
  }
  
  // Use custom actions if provided
  if (data.actions && Array.isArray(data.actions)) {
    options.actions = data.actions;
  }
  
  console.log('[SW] Showing notification:', data.title, options);
  
  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Notification click event - handle action buttons
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.action, event.notification.data);
  
  event.notification.close();
  
  const action = event.action;
  const data = event.notification.data || {};
  const eventId = data.event_id;
  
  // Handle different actions
  if (action === 'dismiss') {
    console.log('[SW] Notification dismissed');
    return;
  }
  
  // Handle event actions that need API calls
  if (eventId && ['accept', 'decline', 'complete', 'snooze'].includes(action)) {
    event.waitUntil(
      handleEventAction(eventId, action)
        .then(() => {
          console.log(`[SW] Action ${action} completed for event ${eventId}`);
          // Show confirmation notification
          return self.registration.showNotification('Argus', {
            body: `Event ${action}ed successfully`,
            icon: '/icon-192.svg',
            tag: 'action-confirmation',
            requireInteraction: false,
          });
        })
        .catch((error) => {
          console.error(`[SW] Action ${action} failed:`, error);
          return self.registration.showNotification('Argus', {
            body: `Failed to ${action} event. Please try from dashboard.`,
            icon: '/icon-192.svg',
            tag: 'action-error',
          });
        })
    );
    return;
  }
  
  // Default: open the app
  const urlToOpen = data.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Check if there's already a window open
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            // Navigate to events page if action was view
            if (action === 'view' && eventId) {
              client.postMessage({ 
                type: 'navigate', 
                page: 'events',
                eventId: eventId,
              });
            }
            return client.focus();
          }
        }
        // Open new window
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
  );
});

// Handle event actions via API
async function handleEventAction(eventId, action) {
  const endpoint = `${API_BASE}/api/events/${eventId}/${action}`;
  
  console.log(`[SW] Calling API: POST ${endpoint}`);
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`API returned ${response.status}`);
  }
  
  const result = await response.json();
  console.log(`[SW] API response:`, result);
  
  return result;
}

// Notification close event
self.addEventListener('notificationclose', (event) => {
  console.log('[SW] Notification closed without action:', event.notification.data);
});

// Message from main app
self.addEventListener('message', (event) => {
  console.log('[SW] Message from app:', event.data);
  
  if (event.data.type === 'skipWaiting') {
    self.skipWaiting();
  }
});

// Background sync (for offline action queuing)
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);
  
  if (event.tag.startsWith('event-action-')) {
    // Re-attempt failed event actions
    const [, , eventId, action] = event.tag.split('-');
    event.waitUntil(handleEventAction(eventId, action));
  }
});
