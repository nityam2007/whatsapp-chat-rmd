/**
 * Push Notification Webapp Server
 * 
 * Enhanced dashboard with:
 * - Push notification subscription management
 * - Proxy to RMD API for dashboard data
 * - Event management
 * - Message viewing
 * - Pipeline logs
 */

// Load environment first
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Try loading from current working directory first
let envResult = dotenv.config();
if (envResult.error) {
  envResult = dotenv.config({ path: path.join(__dirname, '..', '.env') });
}

import express from 'express';
import cors from 'cors';
import webpush from 'web-push';
import fs from 'fs';

const app = express();
const PORT = process.env.WEBAPP_PORT || 3002;
const RMD_API_URL = process.env.RMD_API_URL || 'http://localhost:3000';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store subscriptions in memory (in production, use database)
interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

const subscriptions: Map<string, PushSubscription> = new Map();
const subscriptionsFile = path.join(__dirname, '..', 'data', 'subscriptions.json');

// Load saved subscriptions
function loadSubscriptions() {
  try {
    if (fs.existsSync(subscriptionsFile)) {
      const data = JSON.parse(fs.readFileSync(subscriptionsFile, 'utf-8'));
      Object.entries(data).forEach(([id, sub]) => {
        subscriptions.set(id, sub as PushSubscription);
      });
      console.log(`Loaded ${subscriptions.size} subscriptions`);
    }
  } catch (error) {
    console.error('Failed to load subscriptions:', error);
  }
}

// Save subscriptions
function saveSubscriptions() {
  try {
    const data: Record<string, PushSubscription> = {};
    subscriptions.forEach((sub, id) => {
      data[id] = sub;
    });
    fs.mkdirSync(path.dirname(subscriptionsFile), { recursive: true });
    fs.writeFileSync(subscriptionsFile, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Failed to save subscriptions:', error);
  }
}

loadSubscriptions();

// Configure web-push
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidEmail = process.env.VAPID_EMAIL || 'mailto:admin@example.com';

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidEmail, vapidPublicKey, vapidPrivateKey);
  console.log('VAPID configured successfully');
} else {
  console.warn('VAPID keys not configured - push notifications will not work');
}

// =============================================
// Push Notification API Routes
// =============================================

// Get VAPID public key
app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

// Subscribe to push notifications
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  
  if (!subscription || !subscription.endpoint) {
    res.status(400).json({ error: 'Invalid subscription' });
    return;
  }
  
  const id = Buffer.from(subscription.endpoint).toString('base64').slice(0, 32);
  subscriptions.set(id, subscription);
  saveSubscriptions();
  
  console.log(`New subscription: ${id.slice(0, 8)}...`);
  
  res.json({ 
    success: true, 
    message: 'Subscribed successfully',
    subscriptionId: id 
  });
});

// Unsubscribe
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  
  if (!endpoint) {
    res.status(400).json({ error: 'Endpoint required' });
    return;
  }
  
  const id = Buffer.from(endpoint).toString('base64').slice(0, 32);
  subscriptions.delete(id);
  saveSubscriptions();
  
  console.log(`Unsubscribed: ${id.slice(0, 8)}...`);
  
  res.json({ success: true, message: 'Unsubscribed' });
});

// Send test notification
app.post('/api/test-notification', async (req, res) => {
  const { title, body, subscriptionId } = req.body;
  
  const payload = JSON.stringify({
    title: title || 'Test Notification',
    body: body || 'This is a test push notification from WhatsApp RMD',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    timestamp: Date.now(),
    data: {
      type: 'test',
      url: '/'
    }
  });
  
  const results: { id: string; success: boolean; error?: string }[] = [];
  
  const targetSubs = subscriptionId 
    ? [[subscriptionId, subscriptions.get(subscriptionId)]] 
    : Array.from(subscriptions.entries());
  
  for (const [id, subscription] of targetSubs) {
    if (!subscription) continue;
    
    try {
      await webpush.sendNotification(subscription as webpush.PushSubscription, payload);
      results.push({ id: id as string, success: true });
    } catch (error: any) {
      console.error(`Failed to send to ${(id as string).slice(0, 8)}:`, error.message);
      
      if (error.statusCode === 410 || error.statusCode === 404) {
        subscriptions.delete(id as string);
        saveSubscriptions();
      }
      
      results.push({ id: id as string, success: false, error: error.message });
    }
  }
  
  res.json({ 
    success: true, 
    sent: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    results 
  });
});

// Send notification to all (used by RMD service)
app.post('/api/notify', async (req, res) => {
  const { title, body, data } = req.body;
  
  if (!title) {
    res.status(400).json({ error: 'Title required' });
    return;
  }
  
  const payload = JSON.stringify({
    title,
    body: body || '',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    timestamp: Date.now(),
    data: data || {}
  });
  
  let sent = 0;
  let failed = 0;
  
  for (const [id, subscription] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(subscription as webpush.PushSubscription, payload);
      sent++;
    } catch (error: any) {
      failed++;
      if (error.statusCode === 410 || error.statusCode === 404) {
        subscriptions.delete(id);
      }
    }
  }
  
  if (failed > 0) {
    saveSubscriptions();
  }
  
  res.json({ success: true, sent, failed });
});

// Get subscription stats
app.get('/api/stats', (_req, res) => {
  res.json({
    subscriptions: subscriptions.size,
    vapidConfigured: !!(vapidPublicKey && vapidPrivateKey)
  });
});

// =============================================
// Proxy Routes to RMD API
// =============================================

// Simple proxy function
async function proxyToRMD(path: string, method: string = 'GET', body?: any) {
  const url = `${RMD_API_URL}${path}`;
  
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };
  
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(url, options);
  return response.json();
}

// Dashboard stats
app.get('/api/dashboard/stats', async (_req, res) => {
  try {
    const data = await proxyToRMD('/api/dashboard/stats');
    res.json(data);
  } catch (error) {
    console.error('Failed to fetch dashboard stats:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Events
app.get('/api/events', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query as any).toString();
    const data = await proxyToRMD(`/api/events?${queryString}`);
    res.json(data);
  } catch (error) {
    console.error('Failed to fetch events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const data = await proxyToRMD(`/api/events/${req.params.id}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

app.post('/api/events/:id/accept', async (req, res) => {
  try {
    const data = await proxyToRMD(`/api/events/${req.params.id}/accept`, 'POST');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to accept event' });
  }
});

app.post('/api/events/:id/decline', async (req, res) => {
  try {
    const data = await proxyToRMD(`/api/events/${req.params.id}/decline`, 'POST');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to decline event' });
  }
});

app.post('/api/events/:id/complete', async (req, res) => {
  try {
    const data = await proxyToRMD(`/api/events/${req.params.id}/complete`, 'POST');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to complete event' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const data = await proxyToRMD(`/api/events/${req.params.id}`, 'DELETE');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Messages
app.get('/api/messages', async (req, res) => {
  try {
    const queryString = new URLSearchParams(req.query as any).toString();
    const data = await proxyToRMD(`/api/messages?${queryString}`);
    res.json(data);
  } catch (error) {
    console.error('Failed to fetch messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const data = await proxyToRMD('/api/contacts');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// Logs
app.get('/api/logs', async (_req, res) => {
  try {
    const data = await proxyToRMD('/api/logs');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.get('/api/logs/:step', async (req, res) => {
  try {
    const lines = req.query.lines || 50;
    const data = await proxyToRMD(`/api/logs/${req.params.step}?lines=${lines}`);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// =============================================
// Health & Static Routes
// =============================================

// Health check
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    rmdApiUrl: RMD_API_URL,
  });
});

// Proxy to Grafana (if available)
app.get('/grafana/*', (req, res) => {
  const grafanaUrl = process.env.GRAFANA_URL || 'http://localhost:3001';
  res.redirect(`${grafanaUrl}${req.path.replace('/grafana', '')}`);
});

// Serve index.html for all other routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║              WhatsApp RMD Dashboard & Push Webapp                 ║
╠═══════════════════════════════════════════════════════════════════╣
║  Dashboard:    http://localhost:${String(PORT).padEnd(5)}                              ║
║  RMD API:      ${RMD_API_URL.padEnd(50)}║
║  VAPID:        ${vapidPublicKey ? '✅ Configured' : '❌ Not configured'}                                    ║
║  Subscriptions: ${String(subscriptions.size).padEnd(49)}║
╠═══════════════════════════════════════════════════════════════════╣
║  Features:                                                        ║
║    • Dashboard with stats and upcoming events                     ║
║    • Event management (accept/decline/complete)                   ║
║    • Message history viewer                                       ║
║    • Pipeline logs viewer                                         ║
║    • Push notification management                                 ║
╚═══════════════════════════════════════════════════════════════════╝
  `);
});
