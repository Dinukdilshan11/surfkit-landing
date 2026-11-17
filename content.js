/**
 * Surfkit - Injected Content Script (Manifest V3)
 * Implements attention verification, Shadow DOM isolated ad slice injection,
 * real-time reward countdowns, dynamic frequency/intensity rotation,
 * and hosted A-Ads frame integration.
 */

(() => {
  'use strict';

  // Prevent duplicate execution on the same frame or document
  if (window.__SURFKIT_INITIALIZED__) return;
  window.__SURFKIT_INITIALIZED__ = true;

  const currentDomain = window.location.hostname.toLowerCase();

  // Cross-browser API adapter (Chrome & Firefox)
  const browserAPI = typeof chrome !== 'undefined' && chrome.runtime ? chrome : (typeof browser !== 'undefined' ? browser : null);

  // Frequency and intensity timing & multiplier configuration
  const INTENSITY_CONFIG = {
    low: {
      intervalMs: 60000, // 60s between impressions
      multiplier: 1.0,
      label: 'Low'
    },
    balanced: {
      intervalMs: 30000, // 30s standard interval
      multiplier: 1.2,
      label: 'Balanced'
    },
    high: {
      intervalMs: 15000, // 15s frequent rotation
      multiplier: 2.0,
      label: 'High'
    }
  };

  // Local state cache
  let config = {
    hasAuthUser: false,
    isOperational: false,
    masterEnabled: true,
    isDomainPaused: false,
    intensity: 'balanced',
    intervalMs: 30000,
    multiplier: 1.2,
    baseReward: 0.024,
    conversionRate: 0.001
  };

  let scheduleTimer = null;
  let activeAdElement = null;
  let activeCountdownTimer = null;

  /**
   * Safe wrapper around browser messaging.
   * Protects against "Extension context invalidated" errors when tabs outlive service worker cycles.
   */
  function safeSendMessage(message, callback) {
    try {
      if (!browserAPI || !browserAPI.runtime || !browserAPI.runtime.id) {
        if (typeof callback === 'function') callback(null);
        return Promise.resolve(null);
      }
      if (typeof callback === 'function') {
        browserAPI.runtime.sendMessage(message, (res) => {
          if (browserAPI.runtime.lastError) {
            // Ignore benign disconnection errors
            callback(null);
            return;
          }
          callback(res);
        });
        return;
      }
      return new Promise((resolve) => {
        try {
          browserAPI.runtime.sendMessage(message, (res) => {
            if (browserAPI.runtime.lastError) {
              resolve(null);
            } else {
              resolve(res);
            }
          });
        } catch (e) {
          resolve(null);
        }
      });
    } catch (err) {
      if (typeof callback === 'function') callback(null);
      return Promise.resolve(null);
    }
  }

  /**
   * Initialize tab configuration and start attention scheduling loop
   */
  async function init() {
    try {
      // 1. Direct storage read for fast warm start
      if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
        browserAPI.storage.local.get(['intensity', 'masterEnabled', 'pausedDomains', 'authUser', 'baseRewardPerAd', 'conversionRate'], (stored) => {
          if (stored) {
            if (stored.intensity && INTENSITY_CONFIG[stored.intensity]) {
              config.intensity = stored.intensity;
              config.intervalMs = INTENSITY_CONFIG[stored.intensity].intervalMs;
              config.multiplier = INTENSITY_CONFIG[stored.intensity].multiplier;
            }
            if (typeof stored.masterEnabled === 'boolean') {
              config.masterEnabled = stored.masterEnabled;
            }
            if (stored.baseRewardPerAd) config.baseReward = Number(stored.baseRewardPerAd);
            if (stored.conversionRate) config.conversionRate = Number(stored.conversionRate);
            if (Array.isArray(stored.pausedDomains)) {
              config.isDomainPaused = stored.pausedDomains.includes(currentDomain);
            }
            config.hasAuthUser = Boolean(stored.authUser && stored.authUser.id);
            config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
          }
        });
      }

      // 2. Query background service worker for authoritative operational status
      const response = await safeSendMessage({
        action: 'CHECK_TAB_STATUS',
        payload: { domain: currentDomain }
      });

      if (response && response.success) {
        config = { ...config, ...response };
        if (response.intensity && INTENSITY_CONFIG[response.intensity]) {
          config.intensity = response.intensity;
          config.intervalMs = INTENSITY_CONFIG[response.intensity].intervalMs;
          config.multiplier = INTENSITY_CONFIG[response.intensity].multiplier;
        }
        config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);

        if (config.isOperational) {
          scheduleNextAd(config.intervalMs);
        } else {
          clearTimersAndAd();
        }
      }
    } catch (err) {
      console.debug('[Surfkit Content] Initialization delay:', err.message);
    }
  }

  /**
   * Schedule the next periodic attention ad based on active intensity
   */
  function scheduleNextAd(delayMs) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;

    if (!config.hasAuthUser || !config.isOperational || !config.masterEnabled || config.isDomainPaused) {
      return;
    }

    const waitTime = typeof delayMs === 'number' ? delayMs : config.intervalMs;

    scheduleTimer = setTimeout(() => {
      // Only render if document is currently focused/visible and no ad is currently displayed
      if (document.visibilityState === 'visible' && !activeAdElement) {
        renderFloatingAd({ simulated: false });
      } else {
        // Tab is hidden or ad is currently showing; retry after short interval
        scheduleNextAd(Math.min(10000, config.intervalMs));
      }
    }, waitTime);
  }

  /**
   * Clears all pending timers and removes active ad element
   */
  function clearTimersAndAd() {
    if (scheduleTimer) {
      clearTimeout(scheduleTimer);
      scheduleTimer = null;
    }
    if (activeCountdownTimer) {
      clearInterval(activeCountdownTimer);
      activeCountdownTimer = null;
    }
    if (activeAdElement) {
      try {
        activeAdElement.remove();
      } catch (e) {}
      activeAdElement = null;
    }
  }

  /**
   * Render isolated floating ad slice card via Shadow DOM in the bottom-left corner
   */
  function renderFloatingAd(options = {}) {
    // Strict guard: only render when extension is active, user is authenticated, and no ad is currently displayed
    if (!options.simulated && (!config.hasAuthUser || !config.isOperational || activeAdElement)) {
      return;
    }
    if (options.simulated && activeAdElement) {
      try { activeAdElement.remove(); } catch (e) {}
      activeAdElement = null;
    }

    // Dynamic reward calculation based on user's active intensity
    const intensitySetting = INTENSITY_CONFIG[config.intensity] || INTENSITY_CONFIG.balanced;
    const currentMultiplier = intensitySetting.multiplier || config.multiplier || 1.2;
    const estimatedReward = (config.baseReward * currentMultiplier).toFixed(3);
    const estimatedTokens = Math.round(parseFloat(estimatedReward) / config.conversionRate);

    // Host element placed in bottom-left corner with highest z-index
    const host = document.createElement('div');
    host.id = 'surfkit-ad-slice-host';
    host.style.position = 'fixed';
    host.style.bottom = '20px';
    host.style.left = '20px';
    host.style.width = '300px';
    host.style.height = '250px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'auto';
    host.style.colorScheme = 'dark';

    // Attach open Shadow DOM for complete CSS isolation from host webpage
    const shadow = host.attachShadow({ mode: 'open' });

    // Scoped Stylesheet for the Ad Slice Card
    const style = document.createElement('style');
    style.textContent = `
      :host {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        user-select: none;
        -webkit-user-select: none;
      }
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      .surfkit-card {
        width: 300px;
        height: 250px;
        background: #0c121e;
        border: 1px solid #1e2d42;
        border-radius: 12px;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(0, 210, 147, 0.25), 0 0 24px rgba(0, 210, 147, 0.08);
        color: #e2e8f0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        animation: surfkitSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        transition: transform 0.22s ease, opacity 0.22s ease;
      }
      @keyframes surfkitSlideIn {
        from {
          opacity: 0;
          transform: translateY(25px) scale(0.96);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      .surfkit-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 32px;
        padding: 0 10px;
        background: #111a2b;
        border-bottom: 1px solid #1a273b;
        flex-shrink: 0;
      }
      .brand-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .logo-pill {
        width: 18px;
        height: 18px;
        background: linear-gradient(135deg, #00d293, #06b6d4);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 10px;
        color: #0b111d;
      }
      .brand-title {
        font-size: 11px;
        font-weight: 800;
        color: #ffffff;
        letter-spacing: 0.6px;
        text-transform: uppercase;
      }
      .header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .reward-pill {
        font-size: 10px;
        font-weight: 700;
        color: #00d293;
        background: rgba(0, 210, 147, 0.12);
        border: 1px solid rgba(0, 210, 147, 0.3);
        padding: 1.5px 6px;
        border-radius: 9999px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        transition: all 0.2s ease;
      }
      .reward-pill.awarded {
        color: #0b111d;
        background: #00d293;
        border-color: #00d293;
      }
      .close-btn {
        background: transparent;
        border: none;
        color: #64748b;
        cursor: pointer;
        font-size: 16px;
        font-weight: 700;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 0.15s ease, background 0.15s ease;
      }
      .close-btn:hover {
        color: #f1f5f9;
        background: rgba(255, 255, 255, 0.08);
      }
      .surfkit-body {
        flex: 1;
        width: 100%;
        height: calc(250px - 35px);
        background: #090e17;
        overflow: hidden;
        position: relative;
      }
      .aads-frame {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        background: transparent;
      }
      .progress-track {
        height: 3px;
        width: 100%;
        background: #172338;
        overflow: hidden;
        flex-shrink: 0;
      }
      .progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #00d293, #06b6d4);
        transition: width 0.08s linear;
      }
    `;

    // HTML Structure
    const card = document.createElement('div');
    card.className = 'surfkit-card';
    card.innerHTML = `
      <div class="surfkit-header">
        <div class="brand-group">
          <div class="logo-pill">S</div>
          <span class="brand-title">SURFKIT</span>
        </div>
        <div class="header-actions">
          <span class="reward-pill" id="reward-pill">+ $${estimatedReward}</span>
          <button class="close-btn" id="close-btn" title="Dismiss Ad Slice" aria-label="Close">&times;</button>
        </div>
      </div>
      <div class="surfkit-body">
        <iframe class="aads-frame"
                src="https://surfkit.cloud/ad-frame"
                title="Surfkit A-Ads Sponsored Frame"
                allowtransparency="true"
                sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox">
        </iframe>
      </div>
      <div class="progress-track">
        <div class="progress-fill" id="progress-fill"></div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(card);
    document.documentElement.appendChild(host);
    activeAdElement = host;

    // Attention verification timer logic
    const durationMs = 5000; // 5 seconds view attention
    const intervalTick = 50;
    let elapsedMs = 0;
    let rewardDispatched = false;

    const rewardPill = shadow.getElementById('reward-pill');
    const progressFill = shadow.getElementById('progress-fill');
    const closeBtn = shadow.getElementById('close-btn');

    // Dismissal handler (immediately hides and cleans up)
    function dismissAd(completed) {
      if (activeCountdownTimer) {
        clearInterval(activeCountdownTimer);
        activeCountdownTimer = null;
      }
      if (host && host.parentNode) {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px) scale(0.95)';
        setTimeout(() => {
          if (host.parentNode) host.parentNode.removeChild(host);
          activeAdElement = null;
          // Reschedule next regular ad interval
          scheduleNextAd(config.intervalMs);
        }, 220);
      } else {
        activeAdElement = null;
        scheduleNextAd(config.intervalMs);
      }
    }

    // Close button click listener: immediately dismiss without reward
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissAd(false);
    });

    activeCountdownTimer = setInterval(() => {
      // Pause countdown if user switches tabs or window loses focus
      if (document.visibilityState !== 'visible') return;

      elapsedMs += intervalTick;
      const progressPercent = Math.min(100, (elapsedMs / durationMs) * 100);
      if (progressFill) progressFill.style.width = progressPercent + '%';

      if (elapsedMs >= durationMs && !rewardDispatched) {
        rewardDispatched = true;
        clearInterval(activeCountdownTimer);
        activeCountdownTimer = null;

        if (rewardPill) {
          rewardPill.textContent = `✓ +${estimatedTokens} SKIT Credited!`;
          rewardPill.classList.add('awarded');
        }

        // Notify background service worker of verified impression
        safeSendMessage({
          action: 'RECORD_AD_IMPRESSION',
          payload: {
            domain: currentDomain,
            website_domain: currentDomain,
            slices_earned: estimatedTokens,
            reward_usd: parseFloat(estimatedReward),
            multiplier: currentMultiplier
          }
        }, (res) => {
          if (res && res.success) {
            console.log('[Surfkit Content] Impression credited live! New balance: $' + res.balanceUsd);
          }
        });

        // Auto-dismiss 1.8 seconds after rewarding
        setTimeout(() => {
          dismissAd(true);
        }, 1800);
      }
    }, intervalTick);
  }

  // ========================================================
  // EVENT & MESSAGE LISTENERS
  // ========================================================
  if (browserAPI && browserAPI.runtime && browserAPI.runtime.onMessage) {
    browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || !message.action) return false;
      const { action, payload } = message;

      switch (action) {
        case 'INJECT_AD_UNIT': {
          renderFloatingAd({ simulated: true });
          sendResponse({ success: true, message: 'Ad slice injected' });
          break;
        }

        case 'INTENSITY_CHANGED': {
          if (payload && payload.intensity && INTENSITY_CONFIG[payload.intensity]) {
            const setting = INTENSITY_CONFIG[payload.intensity];
            config.intensity = payload.intensity;
            config.intervalMs = payload.interval || setting.intervalMs;
            config.multiplier = payload.multiplier || setting.multiplier;

            // Reschedule next ad with new frequency if no ad is currently displayed
            if (!activeAdElement && config.isOperational) {
              scheduleNextAd(config.intervalMs);
            }
          }
          sendResponse({ success: true, intensity: config.intensity, interval: config.intervalMs });
          break;
        }

        case 'STATE_CHANGED': {
          const broadcastData = payload || message.data;
          try {
            window.postMessage({
              type: 'SURFKIT_EXTENSION_STATE_UPDATE',
              data: broadcastData
            }, '*');
          } catch (e) {}

          if (broadcastData && 'authUser' in broadcastData) {
            config.hasAuthUser = Boolean(broadcastData.authUser && broadcastData.authUser.id);
          }
          if (broadcastData && broadcastData.isExplicitSignOut && !broadcastData.authUser) {
            config.hasAuthUser = false;
          }
          if (payload && typeof payload.masterEnabled === 'boolean') {
            config.masterEnabled = payload.masterEnabled;
          }
          if (payload && payload.intensity && INTENSITY_CONFIG[payload.intensity]) {
            config.intensity = payload.intensity;
            config.intervalMs = INTENSITY_CONFIG[payload.intensity].intervalMs;
            config.multiplier = INTENSITY_CONFIG[payload.intensity].multiplier;
          }

          config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);

          // If extension turned off or logged out, immediately hide card and cancel timers
          if (!config.isOperational) {
            clearTimersAndAd();
          } else if (!scheduleTimer && !activeAdElement) {
            scheduleNextAd(config.intervalMs);
          }
          break;
        }

        case 'DOMAIN_STATUS_CHANGED': {
          if (payload && payload.domain === currentDomain) {
            config.isDomainPaused = payload.isPaused;
            config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);

            if (!config.isOperational) {
              clearTimersAndAd();
            } else if (!scheduleTimer && !activeAdElement) {
              scheduleNextAd(config.intervalMs);
            }
          }
          break;
        }
      }
      return true;
    });
  }

  // Live storage change sync
  if (browserAPI && browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;

      if (changes.intensity && changes.intensity.newValue && INTENSITY_CONFIG[changes.intensity.newValue]) {
        const val = changes.intensity.newValue;
        config.intensity = val;
        config.intervalMs = INTENSITY_CONFIG[val].intervalMs;
        config.multiplier = INTENSITY_CONFIG[val].multiplier;
        if (!activeAdElement && config.isOperational) {
          scheduleNextAd(config.intervalMs);
        }
      }

      if (changes.masterEnabled && typeof changes.masterEnabled.newValue === 'boolean') {
        config.masterEnabled = changes.masterEnabled.newValue;
        config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
        if (!config.isOperational) {
          clearTimersAndAd();
        } else if (!scheduleTimer && !activeAdElement) {
          scheduleNextAd(config.intervalMs);
        }
      }

      if (changes.pausedDomains && Array.isArray(changes.pausedDomains.newValue)) {
        config.isDomainPaused = changes.pausedDomains.newValue.includes(currentDomain);
        config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
        if (!config.isOperational) {
          clearTimersAndAd();
        } else if (!scheduleTimer && !activeAdElement) {
          scheduleNextAd(config.intervalMs);
        }
      }

      if (changes.authUser) {
        config.hasAuthUser = Boolean(changes.authUser.newValue && changes.authUser.newValue.id);
        config.isOperational = Boolean(config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
        if (!config.isOperational) {
          clearTimersAndAd();
        } else if (!scheduleTimer && !activeAdElement) {
          scheduleNextAd(config.intervalMs);
        }
      }
    });
  }

  // ========================================================
  // BIDIRECTIONAL WEB DASHBOARD BRIDGE (surfkit.cloud)
  // ========================================================
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;
    const { type, action, payload } = event.data;

    if (type === 'SURFKIT_PAGE_GET_STATE') {
      try {
        const response = await safeSendMessage({ action: 'GET_STATE' });
        if (response && response.success && response.data) {
          window.postMessage({
            type: 'SURFKIT_EXTENSION_STATE_UPDATE',
            data: response.data
          }, '*');
        }
      } catch (err) {}
    } else if (type === 'SURFKIT_PAGE_ACTION') {
      try {
        await safeSendMessage({ action, payload });
        const res = await safeSendMessage({ action: 'GET_STATE' });
        if (res && res.success && res.data) {
          window.postMessage({
            type: 'SURFKIT_EXTENSION_STATE_UPDATE',
            data: res.data
          }, '*');
        }
      } catch (err) {}
    }
  });

  // Announce live state to web page on injection
  try {
    safeSendMessage({ action: 'GET_STATE' }, (res) => {
      if (res && res.success && res.data) {
        window.postMessage({
          type: 'SURFKIT_EXTENSION_STATE_UPDATE',
          data: res.data
        }, '*');
      }
    });
  } catch (e) {}

  // Document visibility change listener to pause/resume scheduling
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (config.isOperational && !scheduleTimer && !activeAdElement) {
        scheduleNextAd(config.intervalMs);
      }
    }
  });

  // Execute initialization
  init();
})();
