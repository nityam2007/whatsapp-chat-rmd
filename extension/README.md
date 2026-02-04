# Argus Chrome Extension

A Chrome extension that provides **proactive reminders** based on your browsing context.

## Features

- **Site Detection**: Monitors travel sites (MakeMyTrip, Booking.com), shopping sites (Amazon, Flipkart), streaming services (Netflix), and Google Maps
- **Context Extraction**: Extracts keywords, destinations, and product names from page URLs and titles
- **Proactive Matching**: Queries the Argus backend to find relevant events/reminders
- **Overlay Cards**: Displays reminder cards directly on the page
- **Desktop Notifications**: Fallback notifications when overlay isn't available

## Installation (Development)

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select this `extension/` folder

## Monitored Sites

| Category | Sites |
|----------|-------|
| Travel | MakeMyTrip, Booking.com, Goibibo |
| Shopping | Amazon (IN/COM), Flipkart |
| Streaming | Netflix, Prime Video, Hotstar |
| Navigation | Google Maps |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Extension                         │
├─────────────────────────────────────────────────────────────┤
│  Background Service Worker (background.js)                   │
│  - Monitors tab changes                                      │
│  - Detects site context                                      │
│  - Queries Argus backend                                     │
│  - Manages notifications                                     │
├─────────────────────────────────────────────────────────────┤
│  Content Script (content.js)                                 │
│  - Extracts page context                                     │
│  - Displays overlay cards                                    │
│  - Handles user actions (accept/snooze/dismiss)              │
├─────────────────────────────────────────────────────────────┤
│  Popup (popup.html/js)                                       │
│  - Shows connection status                                   │
│  - Displays recent events                                    │
│  - Quick access to settings                                  │
└─────────────────────────────────────────────────────────────┘
           │
           │ REST API
           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Argus Backend (localhost:3000)            │
│  POST /api/extension/context  - Submit browser context       │
│  GET  /api/extension/by-location - Query by location         │
│  GET  /api/extension/hot-events - Get 3-month events         │
│  GET  /api/extension/status - Connection status              │
└─────────────────────────────────────────────────────────────┘
```

## Configuration

Settings available in the extension options:

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | `http://localhost:3000` | Argus backend URL |
| Enable Overlay | true | Show cards on monitored pages |
| Enable Notifications | true | Show desktop notifications |
| Max Notifications | 3 | Limit per page visit |
| Debounce Delay | 3000ms | Wait after tab change |
| Cooldown Period | 5 minutes | Minimum between site checks |

## Icons

The extension requires PNG icons at these sizes:
- `icons/icon-16.png` (16x16)
- `icons/icon-32.png` (32x32)
- `icons/icon-48.png` (48x48)
- `icons/icon-128.png` (128x128)

You can generate these from the included `icon-128.svg` using ImageMagick:

```bash
convert icons/icon-128.svg -resize 16x16 icons/icon-16.png
convert icons/icon-128.svg -resize 32x32 icons/icon-32.png
convert icons/icon-128.svg -resize 48x48 icons/icon-48.png
convert icons/icon-128.svg -resize 128x128 icons/icon-128.png
```

## Privacy

- The extension only monitors specific sites (defined in manifest.json)
- Page content is NOT sent to the server - only URL, title, and extracted keywords
- All data is processed locally where possible
- No tracking or analytics
