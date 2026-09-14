// YouTube Subscriber Badge
// Scrapes each channel's public "About" page for its subscriber-count text
// (no API key required), caches results locally, and injects a small
// "👥 12.3K" badge under the channel name on suggested/recommended videos.
//
// YouTube's UI is built out of Web Components with *shadow DOM* (search
// results, the watch-page sidebar, home grid, etc. each nest their content
// inside one or more shadow roots), and it's also a single-page app that
// swaps content in without a full reload. Both of those break naive
// "watch the document for new nodes" approaches, so this script:
//   1. Deep-scans through shadow roots wherever it looks (deepQueryAll).
//   2. Re-scans immediately on YouTube's own `yt-navigate-finish` event
//      (fired on every client-side page change: opening search, a video, a
//      channel, etc.), instead of waiting to notice new elements.
//   3. Also re-scans on a short fallback timer, in case something slips
//      through both of the above.
// It intentionally does NOT gate on visibility/IntersectionObserver anymore
// — that turned out to be unreliable against YouTube's virtualization, and
// with per-channel caching + a small concurrent-fetch limit, processing
// every card that exists is still cheap.

(() => {
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const MAX_CONCURRENT_FETCHES = 2;
  const FETCH_SPACING_MS = 200;
  const MAX_LINK_RETRIES = 12;
  const LINK_RETRY_DELAY_MS = 300;
  const RESCAN_INTERVAL_MS = 1200;

  const DEBUG = false; // flip to true and check the console if badges still don't show up

  const RENDERER_SELECTOR = [
    'ytd-compact-video-renderer', // watch-page "up next" sidebar (legacy)
    'ytd-video-renderer', // search results (legacy)
    'ytd-rich-item-renderer', // home page grid (legacy wrapper)
    'ytd-grid-video-renderer', // channel/grid pages (legacy)
    'ytd-reel-item-renderer', // shorts shelf (legacy)
    'yt-lockup-view-model', // new unified video card (sidebar, grid, search)
    'ytm-shorts-lockup-view-model', // shorts (new)
    'ytm-shorts-lockup-view-model-v2', // shorts (new v2)
    'grid-shelf-view-model' // shelf items (new)
  ].join(', ');

  function log(...args) {
    if (DEBUG) console.debug('[yt-subs-badge]', ...args);
  }

  // ---------------------------------------------------------------------
  // Shadow-DOM-piercing query helper
  // ---------------------------------------------------------------------

  // Recursively collects every element matching `selector`, descending into
  // any open shadow root it encounters along the way (at any depth).
  function deepQueryAll(root, selector) {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || !node.querySelectorAll) continue;
      const children = node.querySelectorAll('*');
      for (const child of children) {
        if (child.matches && child.matches(selector)) out.push(child);
        if (child.shadowRoot) stack.push(child.shadowRoot);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Fetch queue + cache
  // ---------------------------------------------------------------------

  const inFlight = new Map(); // channelUrl -> Promise<string|null>
  const queue = [];
  let activeFetches = 0;

  function pump() {
    while (activeFetches < MAX_CONCURRENT_FETCHES && queue.length) {
      const job = queue.shift();
      activeFetches++;
      job().finally(() => {
        activeFetches--;
        setTimeout(pump, FETCH_SPACING_MS);
      });
    }
  }

  function enqueue(job) {
    queue.push(job);
    pump();
  }

  function normalizeChannelUrl(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const path = url.pathname.replace(/\/+$/, '');
      if (!/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+)$/.test(path)) return null;
      return `https://www.youtube.com${path}`;
    } catch {
      return null;
    }
  }

  function extractSubscriberText(html) {
    let m = html.match(
      /"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"\}\},"simpleText":"([^"]+)"\}/
    );
    let raw = m ? (m[2] || m[1]) : null;
    if (!raw) {
      m = html.match(/"subscriberCountText":\{"simpleText":"([^"]+)"\}/);
      raw = m ? m[1] : null;
    }
    if (!raw) return null;
    return raw.replace(/\s*subscribers?/i, '').trim();
  }

  function getCached(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (res) => resolve(res[key] || null));
      } catch {
        resolve(null);
      }
    });
  }

  function setCached(key, value) {
    try {
      chrome.storage.local.set({ [key]: value });
    } catch {
      /* ignore quota/errors */
    }
  }

  async function fetchSubscriberCount(channelUrl) {
    const aboutUrl = `${channelUrl}/about`;
    const res = await fetch(aboutUrl, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const html = await res.text();
    return extractSubscriberText(html);
  }

  async function getSubscriberCount(channelUrl) {
    const cached = await getCached(channelUrl);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.subs;
    }
    if (inFlight.has(channelUrl)) return inFlight.get(channelUrl);

    const promise = new Promise((resolve) => {
      enqueue(async () => {
        let subs = null;
        try {
          subs = await fetchSubscriberCount(channelUrl);
        } catch {
          subs = null;
        }
        setCached(channelUrl, { subs, ts: Date.now() });
        resolve(subs);
      });
    });
    inFlight.set(channelUrl, promise);
    promise.finally(() => inFlight.delete(channelUrl));
    return promise;
  }

  // ---------------------------------------------------------------------
  // Finding the channel link + a good place to put the badge
  // ---------------------------------------------------------------------

  function findChannelLink(container) {
    // Don't rely on ids/classes (YouTube renames these often, and the actual
    // markup usually lives inside the container's own shadow root). Instead,
    // deep-scan for every link and pick the one that (a) points at a channel
    // and (b) has visible text — that rules out the avatar-only link.
    const anchors = deepQueryAll(container, 'a[href]');
    let fallback = null;
    for (const a of anchors) {
      const channelUrl = normalizeChannelUrl(a.getAttribute('href'));
      if (!channelUrl) continue;
      if (!fallback) fallback = a;
      if (a.textContent && a.textContent.trim().length > 0) {
        return a;
      }
    }
    return fallback;
  }

  // Long/truncated channel names live in a tightly-fitted row. Rather than
  // squeezing our badge into that same row (where it can get clipped or
  // shove the name further), we anchor to the row itself and render the
  // badge as its own block underneath it.
  function getInsertionAnchor(link) {
    return (
      link.closest(
        'yt-content-metadata-view-model, ytd-channel-name, #channel-name, #byline-container, #metadata'
      ) || link.parentElement ||
      link
    );
  }

  function insertBadge(link) {
    const anchor = getInsertionAnchor(link);
    if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('yt-subs-badge')) {
      return anchor.nextElementSibling;
    }
    const badge = document.createElement('span');
    badge.className = 'yt-subs-badge yt-subs-badge--pending';
    badge.textContent = '👥 •••';
    anchor.insertAdjacentElement('afterend', badge);
    return badge;
  }

  function resolveBadge(badge, subs) {
    if (!badge || !badge.isConnected) return;
    if (!subs) {
      badge.remove(); // hidden/unavailable subscriber count — don't leave a placeholder
      return;
    }
    badge.textContent = `👥 ${subs}`;
    badge.classList.remove('yt-subs-badge--pending');
  }

  function handleContainer(container, attempt = 0) {
    const link = findChannelLink(container);
    if (!link) {
      if (attempt < MAX_LINK_RETRIES) {
        setTimeout(() => handleContainer(container, attempt + 1), LINK_RETRY_DELAY_MS);
      } else {
        log('gave up finding channel link', container);
      }
      return;
    }
    if (link.dataset.subsBadgeDone) return;
    const channelUrl = normalizeChannelUrl(link.getAttribute('href'));
    if (!channelUrl) return;
    link.dataset.subsBadgeDone = '1';

    const badge = insertBadge(link);
    log('fetching', channelUrl);
    getSubscriberCount(channelUrl).then((subs) => {
      log('result', channelUrl, subs);
      resolveBadge(badge, subs);
    });
  }

  // ---------------------------------------------------------------------
  // Discovering video cards
  // ---------------------------------------------------------------------

  const seenContainers = new WeakSet();

  function scan(root) {
    const containers = deepQueryAll(root, RENDERER_SELECTOR);
    let found = 0;
    for (const container of containers) {
      if (seenContainers.has(container)) continue;
      seenContainers.add(container);
      found++;
      handleContainer(container);
    }
    if (found) log(`scan found ${found} new container(s)`);
  }

  function rescan() {
    scan(document);
  }

  function init() {
    rescan();

    // React immediately to YouTube's own SPA navigation event, rather than
    // waiting for the fallback timer.
    document.addEventListener('yt-navigate-finish', () => {
      log('yt-navigate-finish -> rescanning');
      rescan();
    });

    // Light-DOM mutation observer as a fast-path for ordinary additions
    // (infinite scroll, etc.). Harmless if it misses shadow-only changes,
    // since the interval below covers those.
    const mo = new MutationObserver(() => rescan());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Fallback net: catches anything created inside shadow roots that the
    // observer above can't see, and anything the navigate event missed.
    setInterval(rescan, RESCAN_INTERVAL_MS);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
