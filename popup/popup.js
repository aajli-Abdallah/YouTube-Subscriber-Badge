const DEFAULT_SETTINGS = {
  masterEnabled: true,
  showOnFeed: true,
  showOnSearch: true,
  showOnSidebar: true,
  showOnComments: true,
  badgeFormat: 'emoji', // 'emoji' | 'label' | 'compact'
  colorTiers: true
};

const elements = {
  master: document.getElementById('toggle-master'),
  mainContent: document.getElementById('main-content'),
  feed: document.getElementById('toggle-feed'),
  search: document.getElementById('toggle-search'),
  sidebar: document.getElementById('toggle-sidebar'),
  comments: document.getElementById('toggle-comments'),
  tiers: document.getElementById('toggle-tiers'),
  tierLegend: document.getElementById('tier-legend'),
  cacheStatus: document.getElementById('cache-status'),
  btnClearCache: document.getElementById('btn-clear-cache'),
  actionFeedback: document.getElementById('action-feedback'),
  formatRadios: document.querySelectorAll('input[name="badge-format"]')
};

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['yt_subs_settings'], (result) => {
      const settings = Object.assign({}, DEFAULT_SETTINGS, result.yt_subs_settings || {});
      resolve(settings);
    });
  });
}

function saveSettings(settings) {
  chrome.storage.local.set({ yt_subs_settings: settings });
}

function updateUI(settings) {
  elements.master.checked = settings.masterEnabled;
  elements.feed.checked = settings.showOnFeed;
  elements.search.checked = settings.showOnSearch;
  elements.sidebar.checked = settings.showOnSidebar;
  elements.comments.checked = settings.showOnComments;
  elements.tiers.checked = settings.colorTiers;

  elements.formatRadios.forEach((radio) => {
    radio.checked = radio.value === settings.badgeFormat;
  });

  if (settings.masterEnabled) {
    elements.mainContent.classList.remove('disabled-content');
  } else {
    elements.mainContent.classList.add('disabled-content');
  }

  elements.tierLegend.style.opacity = settings.colorTiers ? '1' : '0.35';
}

function gatherSettingsFromUI() {
  let selectedFormat = 'emoji';
  elements.formatRadios.forEach((radio) => {
    if (radio.checked) selectedFormat = radio.value;
  });

  return {
    masterEnabled: elements.master.checked,
    showOnFeed: elements.feed.checked,
    showOnSearch: elements.search.checked,
    showOnSidebar: elements.sidebar.checked,
    showOnComments: elements.comments.checked,
    badgeFormat: selectedFormat,
    colorTiers: elements.tiers.checked
  };
}

function onSettingChanged() {
  const settings = gatherSettingsFromUI();
  updateUI(settings);
  saveSettings(settings);
}

function updateCacheStats() {
  chrome.storage.local.get(null, (items) => {
    let count = 0;
    for (const key in items) {
      if (key.startsWith('https://www.youtube.com/') || (items[key] && items[key].subs !== undefined)) {
        count++;
      }
    }
    elements.cacheStatus.textContent = `${count} channel${count === 1 ? '' : 's'} stored`;
  });
}

function clearCache() {
  chrome.storage.local.get(null, (items) => {
    const keysToRemove = [];
    for (const key in items) {
      if (key !== 'yt_subs_settings') {
        keysToRemove.push(key);
      }
    }
    if (keysToRemove.length > 0) {
      chrome.storage.local.remove(keysToRemove, () => {
        elements.actionFeedback.textContent = 'Cache cleared!';
        updateCacheStats();
        setTimeout(() => {
          elements.actionFeedback.textContent = '';
        }, 2000);
      });
    } else {
      elements.actionFeedback.textContent = 'Cache already empty';
      setTimeout(() => {
        elements.actionFeedback.textContent = '';
      }, 2000);
    }
  });
}

async function init() {
  const settings = await loadSettings();
  updateUI(settings);
  updateCacheStats();

  // Attach event listeners
  elements.master.addEventListener('change', onSettingChanged);
  elements.feed.addEventListener('change', onSettingChanged);
  elements.search.addEventListener('change', onSettingChanged);
  elements.sidebar.addEventListener('change', onSettingChanged);
  elements.comments.addEventListener('change', onSettingChanged);
  elements.tiers.addEventListener('change', onSettingChanged);

  elements.formatRadios.forEach((radio) => {
    radio.addEventListener('change', onSettingChanged);
  });

  elements.btnClearCache.addEventListener('click', clearCache);
}

document.addEventListener('DOMContentLoaded', init);
