// YouTube Subscriber Badge v2.0.0
// Displays channel subscriber counts on YouTube video cards, search results,
// watch sidebar, and comments section without requiring an API key.

(() => {
  const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for valid counts
  const ERROR_RETRY_TTL_MS = 2 * 60 * 1000; // 2 minutes retry for network errors
  const MAX_CONCURRENT_FETCHES = 2;
  const FETCH_SPACING_MS = 200;
  const MAX_LINK_RETRIES = 10;
  const LINK_RETRY_DELAY_MS = 300;
  const RESCAN_INTERVAL_MS = 1500;
  const DEBOUNCE_MUTATION_MS = 150;

  const DEBUG = false;

  const DEFAULT_SETTINGS = {
    masterEnabled: true,
    showOnFeed: true,
    showOnSearch: true,
    showOnSidebar: true,
    showOnComments: true,
    badgeFormat: 'emoji', // 'emoji' | 'label' | 'compact'
    colorTiers: true
  };

  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  const RENDERER_SELECTOR = [
    // Video cards
    'ytd-compact-video-renderer', // watch-page sidebar (legacy)
    'ytd-video-renderer', // search results (legacy)
    'ytd-rich-item-renderer', // home page grid (legacy wrapper)
    'ytd-grid-video-renderer', // channel/grid pages (legacy)
    'ytd-reel-item-renderer', // shorts shelf (legacy)
    'yt-lockup-view-model', // modern unified video card (sidebar, grid, search)
    'ytm-shorts-lockup-view-model', // shorts
    'ytm-shorts-lockup-view-model-v2', // shorts v2
    'grid-shelf-view-model', // shelf items
    'ytd-channel-renderer', // search channel cards
    // Comments
    'ytd-comment-view-model', // modern comments
    'ytd-comment-thread-renderer' // legacy comment threads
  ].join(', ');

  function log(...args) {
    if (DEBUG) console.debug('[yt-subs-badge]', ...args);
  }

  // ---------------------------------------------------------------------
  // Settings Management
  // ---------------------------------------------------------------------

  function loadSettings() {
    try {
      chrome.storage.local.get(['yt_subs_settings'], (result) => {
        if (result && result.yt_subs_settings) {
          currentSettings = Object.assign({}, DEFAULT_SETTINGS, result.yt_subs_settings);
        }
        applySettingsToAllBadges();
      });
    } catch {
      /* Extension context may be invalidated during reload */
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.yt_subs_settings) {
        currentSettings = Object.assign({}, DEFAULT_SETTINGS, changes.yt_subs_settings.newValue || {});
        applySettingsToAllBadges();
      }
    });
  } catch {
    /* ignore */
  }

  function isSurfaceEnabled(surface) {
    if (!currentSettings.masterEnabled) return false;
    if (surface === 'feed') return currentSettings.showOnFeed;
    if (surface === 'search') return currentSettings.showOnSearch;
    if (surface === 'sidebar') return currentSettings.showOnSidebar;
    if (surface === 'comments') return currentSettings.showOnComments;
    return true;
  }

  function parseSubscriberCount(str) {
    if (!str) return null;
    const clean = str.trim().toUpperCase().replace(/,/g, '');
    const match = clean.match(/^([\d.]+)\s*([KMB])?$/);
    if (!match) return null;
    const val = parseFloat(match[1]);
    if (isNaN(val)) return null;
    const multiplier = match[2];
    if (multiplier === 'K') return val * 1e3;
    if (multiplier === 'M') return val * 1e6;
    if (multiplier === 'B') return val * 1e9;
    return val;
  }

  function getSubscriberTier(num) {
    if (num === null || num === undefined) return null;
    if (num < 10000) return 'bronze';
    if (num < 100000) return 'silver';
    if (num < 1000000) return 'gold';
    return 'diamond';
  }

  function formatBadgeText(rawSubs) {
    if (!rawSubs) return '';
    switch (currentSettings.badgeFormat) {
      case 'label':
        return `${rawSubs} subs`;
      case 'compact':
        return rawSubs;
      case 'emoji':
      default:
        return `👥 ${rawSubs}`;
    }
  }

  function applySettingsToBadge(badge) {
    if (!badge || !badge.isConnected) return;
    const surface = badge.dataset.surface || 'feed';
    const enabled = isSurfaceEnabled(surface);

    if (!enabled) {
      badge.classList.add('yt-subs-badge-hidden');
      return;
    }
    badge.classList.remove('yt-subs-badge-hidden');

    const subs = badge.dataset.subs;
    if (!subs) return;

    badge.textContent = formatBadgeText(subs);

    // Remove existing tier classes
    badge.classList.remove(
      'yt-subs-tier-bronze',
      'yt-subs-tier-silver',
      'yt-subs-tier-gold',
      'yt-subs-tier-diamond'
    );

    if (currentSettings.colorTiers) {
      const count = parseSubscriberCount(subs);
      const tier = getSubscriberTier(count);
      if (tier) {
        badge.classList.add(`yt-subs-tier-${tier}`);
      }
    }
  }

  function applySettingsToAllBadges() {
    const badges = document.querySelectorAll('.yt-subs-badge');
    badges.forEach(applySettingsToBadge);
  }

  // ---------------------------------------------------------------------
  // Shadow-DOM-piercing query helper
  // ---------------------------------------------------------------------

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

  const inFlight = new Map();
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
      if (!/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)$/.test(path)) return null;
      return `https://www.youtube.com${path}`;
    } catch {
      return null;
    }
  }

  function extractSubscriberText(html, channelUrl) {
    if (!html) return null;

    // Modern channel pages store the channel's own count as a plain string in
    // channelAboutFullMetadataRenderer, followed by its canonical URL.  The
    // same response also has object-shaped counts for channels linked in the
    // About text, so associate this value with the URL we actually requested.
    try {
      const requestedPath = new URL(channelUrl).pathname.toLowerCase();
      const countPattern = /"subscriberCountText":"([^"]+)"/g;
      let countMatch;
      while ((countMatch = countPattern.exec(html))) {
        const following = html.slice(countMatch.index, countMatch.index + 4000).toLowerCase();
        const isRequestedChannel =
          following.includes(`"canonicalchannelurl":"http://www.youtube.com${requestedPath}`) ||
          following.includes(`"canonicalchannelurl":"https://www.youtube.com${requestedPath}`);
        const normalized = countMatch[1].replace(/\s*subscribers?/i, '').trim();
        if (isRequestedChannel && parseSubscriberCount(normalized) !== null) {
          return normalized;
        }
      }
    } catch {
      // Continue with the older response shapes below.
    }

    // A channel /about response contains data for its video shelves as well as
    // the channel header.  Using String.match() here used the first count in
    // the payload, which can be a completely unrelated channel on that page.
    // Gather every subscriberCountText and favour the one inside the header.
    const candidates = [];
    let offset = 0;
    while (true) {
      const index = html.indexOf('"subscriberCountText":', offset);
      if (index === -1) break;

      // subscriberCountText is a small object; its rendered string occurs
      // shortly after the field name in all current YouTube response shapes.
      const field = html.slice(index, index + 1200);
      const textMatch =
        field.match(/"simpleText":"([^"]+)"/) ||
        field.match(/"text":"([^"]+)"/) ||
        field.match(/"label":"([^"]+subscribers?)"/i);
      const raw = textMatch && textMatch[1];
      const normalized = raw && raw.replace(/\s*subscribers?/i, '').trim();

      if (normalized && parseSubscriberCount(normalized) !== null) {
        const context = html.slice(Math.max(0, index - 12000), index + 1200);
        let score = 0;
        if (/c4TabbedHeaderRenderer|channelHeaderRenderer|pageHeaderRenderer|channelMetadataRenderer/i.test(context)) {
          score += 100;
        }
        if (/videoRenderer|compactVideoRenderer|richItemRenderer|reelItemRenderer/i.test(context)) {
          score -= 10;
        }
        candidates.push({ normalized, score, index });
      }
      offset = index + 1;
    }

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score || a.index - b.index);
      return candidates[0].normalized;
    }

    // Compatibility fallback for older response formats that do not expose
    // subscriberCountText on the channel header.
    const subtitle = html.match(/"subtitle":\{"runs":\[\{"text":"([^"]+)"\}\]\}/);
    if (subtitle && /subscribers?/i.test(subtitle[1])) {
      return subtitle[1].replace(/\s*subscribers?/i, '').trim();
    }
    return null;
  }

  function getCached(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (res) => resolve(res ? res[key] || null : null));
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
    if (!res.ok) {
      if (res.status === 429) {
        log('rate limited (429) for', channelUrl);
      }
      return { subs: null, isError: true };
    }
    const html = await res.text();
    const subs = extractSubscriberText(html, channelUrl);
    return { subs, isError: false };
  }

  async function getSubscriberCount(channelUrl) {
    // Bump the cache namespace when extraction logic changes so an incorrect
    // value from an older version is never shown for its full cache lifetime.
    const cacheKey = `yt-subs-v3:${channelUrl}`;
    const cached = await getCached(cacheKey);
    const ttl = (cached && cached.isError) ? ERROR_RETRY_TTL_MS : CACHE_TTL_MS;

    if (cached && Date.now() - cached.ts < ttl) {
      return cached.subs;
    }
    if (inFlight.has(channelUrl)) return inFlight.get(channelUrl);

    const promise = new Promise((resolve) => {
      enqueue(async () => {
        let result = { subs: null, isError: false };
        try {
          result = await fetchSubscriberCount(channelUrl);
        } catch {
          result = { subs: null, isError: true };
        }
        setCached(cacheKey, {
          subs: result.subs,
          isError: result.isError,
          ts: Date.now()
        });
        resolve(result.subs);
      });
    });
    inFlight.set(channelUrl, promise);
    promise.finally(() => inFlight.delete(channelUrl));
    return promise;
  }

  // ---------------------------------------------------------------------
  // Channel link discovery & surface detection
  // ---------------------------------------------------------------------

  function detectSurface(container) {
    if (container.closest('ytd-comments, #comments, ytd-comment-thread-renderer, ytd-comment-view-model')) {
      return 'comments';
    }
    if (location.pathname === '/results' || container.closest('ytd-search, #search')) {
      return 'search';
    }
    if (location.pathname === '/watch') {
      if (container.closest('#secondary, #related, ytd-watch-next-secondary-results-renderer')) {
        return 'sidebar';
      }
      if (container.closest('ytd-watch-metadata, #owner')) {
        return 'sidebar';
      }
    }
    return 'feed';
  }

  function findChannelLink(container, isComment) {
    if (isComment) {
      const commentAuthor =
        container.querySelector('a#author-text, #author-text a, a.yt-simple-endpoint') ||
        deepQueryAll(container, 'a#author-text, a.yt-simple-endpoint')[0];
      if (commentAuthor && normalizeChannelUrl(commentAuthor.getAttribute('href'))) {
        return commentAuthor;
      }
    }

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

  function getInsertionAnchor(link, isComment) {
    if (isComment) {
      return (
        link.closest('#header-author, #author-comment-badge, #author-text') ||
        link.parentElement ||
        link
      );
    }

    return (
      link.closest(
        'yt-content-metadata-view-model, ytd-channel-name, #channel-name, #byline-container, #metadata'
      ) ||
      link.parentElement ||
      link
    );
  }

  function insertBadge(link, surface, isComment) {
    const anchor = getInsertionAnchor(link, isComment);
    if (anchor.nextElementSibling && anchor.nextElementSibling.classList.contains('yt-subs-badge')) {
      return anchor.nextElementSibling;
    }

    const badge = document.createElement('span');
    badge.className = 'yt-subs-badge yt-subs-badge--pending';
    if (isComment) {
      badge.classList.add('yt-subs-badge--comment');
    }
    badge.dataset.surface = surface;

    if (!isSurfaceEnabled(surface)) {
      badge.classList.add('yt-subs-badge-hidden');
    }

    badge.textContent = '👥 •••';
    anchor.insertAdjacentElement('afterend', badge);
    return badge;
  }

  function resolveBadge(badge, subs) {
    if (!badge || !badge.isConnected) return;
    if (!subs) {
      badge.remove();
      return;
    }
    badge.dataset.subs = subs;
    badge.classList.remove('yt-subs-badge--pending');
    applySettingsToBadge(badge);
  }

  function handleContainer(container, attempt = 0) {
    const isComment = !!container.closest('ytd-comment-view-model, ytd-comment-thread-renderer');
    const surface = detectSurface(container);

    if (!isSurfaceEnabled(surface)) return;

    const link = findChannelLink(container, isComment);
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

    const badge = insertBadge(link, surface, isComment);
    getSubscriberCount(channelUrl).then((subs) => {
      resolveBadge(badge, subs);
    });
  }

  // ---------------------------------------------------------------------
  // Discovery & Rescan Engine
  // ---------------------------------------------------------------------

  const seenContainers = new WeakSet();

  function scan(root) {
    if (!currentSettings.masterEnabled) return;
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

  let debounceTimer = null;
  function debouncedRescan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      rescan();
    }, DEBOUNCE_MUTATION_MS);
  }

  function init() {
    loadSettings();
    rescan();

    // YouTube SPA navigation
    document.addEventListener('yt-navigate-finish', () => {
      log('yt-navigate-finish -> rescanning');
      rescan();
    });

    // Debounced MutationObserver for dynamic infinite scroll
    const mo = new MutationObserver(() => debouncedRescan());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Periodic safety net for open shadow roots
    setInterval(rescan, RESCAN_INTERVAL_MS);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
