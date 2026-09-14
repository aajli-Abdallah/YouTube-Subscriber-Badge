# YouTube Subscriber Badge

Adds a small `👥 12.3K` badge next to the channel name on YouTube suggested /
recommended video cards (home page grid, watch-page "up next" sidebar,
search results).

## How it works

YouTube doesn't include subscriber counts in the suggested-video feed itself.
This extension fetches each channel's public `/about` page in the background
(same-origin request, no API key), extracts the subscriber-count text that
YouTube already embeds in that page's data, caches it per-channel for 6 hours
in `chrome.storage.local`, and inserts a badge under the channel name. While a
fetch is in flight it shows a pulsing `👥 •••` placeholder, then swaps in the
real count once it resolves (or removes itself if the channel hides its
count).

Two things about YouTube's page make this harder than a normal site:

- **Shadow DOM.** The home grid, search results, and the watch-page sidebar
  each nest their video cards inside one or more shadow roots, which a plain
  `document.querySelectorAll` can't see into. Every scan in this extension
  descends into open shadow roots wherever it finds them.
- **Single-page app.** Navigating to search or a video doesn't reload the
  page, so this extension re-scans on YouTube's own `yt-navigate-finish`
  event (fired on every internal page change) instead of waiting to notice
  new elements, plus a ~1.2s fallback timer as a safety net.

Fetches are throttled to 2 concurrent requests with spacing between them, and
a channel already fetched recently is served from cache instead of re-fetched.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions` for Edge).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open or refresh youtube.com — badges appear as cards scroll into view.

## Limitations / notes

- **Unofficial, scraping-based.** It parses public page markup rather than
  using the official YouTube Data API, so it may need small selector/regex
  fixes if YouTube changes its page structure.
- **Hidden counts:** channels that hide their subscriber count will show no
  badge.
- **No API key/quota needed**, but this does mean it makes an extra network
  request per unique channel encountered (cached afterward). If you'd
  rather use the official YouTube Data API (with a key, subject to Google's
  quota), that's a straightforward swap in `fetchSubscriberCount()`.
- Only requests `https://www.youtube.com/*` — no other host permissions.

## Files

- `manifest.json` — MV3 manifest
- `content.js` — scanning, caching, fetching, badge injection
- `styles.css` — badge appearance (adapts to light/dark theme via YouTube's
  own CSS variables)
