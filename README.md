# YouTube Subscriber Badge v2.0.0

A lightweight, API-key-free browser extension that displays subscriber counts next to channel names across YouTube: home feed, search results, watch sidebar, and the comments section.

---

## ✨ Features in v2.0.0

- 📊 **Universal Subscriber Badges**: Badges appear on home feed cards, watch sidebar recommendations, search results, and comments.
- ⚙️ **Interactive Settings Popup**:
  - Master toggle to quickly turn badges on or off.
  - Granular display surface toggles (Home, Search, Sidebar, Comments).
  - Multiple badge formats: `👥 12.3K`, `12.3K subs`, or compact `12.3K`.
  - Cache management dashboard showing active stored channels and a one-click "Clear Cache" button.
- 🏆 **Milestone Tier Color-Coding**:
  - 🥉 **Bronze**: &lt; 10K subscribers
  - 🥈 **Silver**: 10K – 100K subscribers
  - 🥇 **Gold**: 100K – 1M subscribers
  - 💎 **Diamond**: 1M+ subscribers
- 💬 **Comments Section Integration**: Automatically shows subscriber counts for comment authors.
- 🚀 **High Performance & Resilience**:
  - Deep-scans modern YouTube Web Components & open Shadow DOM.
  - Multi-pattern regex extraction with fallback support for modern and legacy YouTube channel URLs (`/@handle`, `/channel/`, `/c/`, `/user/`).
  - Network-safe rate limiting with exponential backoff on HTTP 429.
  - Local caching with 6-hour TTL (`chrome.storage.local`).
- 🎨 **Official Extension Branding**: Custom-designed icons (16px, 32px, 48px, 128px) with native light & dark theme integration.

---

## 🛠️ How It Works

YouTube doesn't embed subscriber counts directly into suggested feed cards or comments. This extension:
1. Performs background same-origin requests to the channel's public `/about` page (no Google API key or quota needed).
2. Parses public metadata using multi-layer regex fallbacks.
3. Caches counts per-channel in `chrome.storage.local` to minimize network overhead.
4. Throttles concurrent requests with rate-limiting protection.
5. Dynamically injects styled badges under channel titles and inline next to comment usernames.

---

## 📦 Installation (Load Unpacked)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/aajli-Abdallah/YouTube-Subscriber-Badge.git
   ```
2. Open your browser extension manager:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the extension folder (`YouTube-Subscriber-Badge`).
5. Open or refresh [YouTube](https://www.youtube.com) — click the extension icon in your browser toolbar to customize settings.

---

## 📂 Project Structure

```text
YouTube-Subscriber-Badge/
├── icons/
│   ├── icon16.png        # 16x16 toolbar icon
│   ├── icon32.png        # 32x32 retina icon
│   ├── icon48.png        # 48x48 extensions management icon
│   └── icon128.png       # 128x128 webstore / high-res icon
├── popup/
│   ├── popup.html        # Settings dashboard markup
│   ├── popup.css         # Modern YouTube-themed styling
│   └── popup.js          # Settings persistence & cache manager
├── content.js            # Core scanner, scraper, cache, & DOM injector
├── styles.css            # Badge styles, animations, & milestone tiers
├── manifest.json         # Manifest V3 extension configuration
└── README.md             # Documentation
```

---

## 🔒 Permissions

- `storage`: Required for saving user preferences and caching channel counts locally.
- `https://www.youtube.com/*`: Required to inject badges and fetch public channel metadata.
- **No external API keys, tracking, analytics, or third-party servers.**
