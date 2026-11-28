/**
 * Surfkit - Injected Content Script (Manifest V3)
 * Implements:
 * 1. Bottom-right positioning (bottom: 20px; right: 20px) with compact 300x250 wrapped layout.
 * 2. Header with SURFKIT branding and close (×) button ONLY (no cash/earning counter badge).
 * 3. Strict hourly frequency adherence by intensity (Low: 2/hr, Balanced: 4/hr, High: 6/hr).
 * 4. Manual close cooldown (card will not pop up again until the scheduled interval elapses).
 * 5. Full Shadow DOM style isolation to prevent host page CSS interference.
 */

(() => {
  'use strict';

  // Feature flag: ad-network compliance & dashboard-only rewards model
  const ENABLE_EXTERNAL_AD_INJECTION = false;


  // Prevent duplicate execution on the same document or frame
  if (window.__SURFKIT_INITIALIZED__) return;
  window.__SURFKIT_INITIALIZED__ = true;

  const currentDomain = window.location.hostname.toLowerCase();

  // Cross-browser runtime adapter (Chrome & Firefox)
  const browserAPI = typeof chrome !== 'undefined' && chrome.runtime ? chrome : (typeof browser !== 'undefined' ? browser : null);

  // Strict hourly frequency configuration:
  // Low: Exactly 2 impressions / hour (30-minute interval = 1,800,000 ms)
  // Balanced: Exactly 4 impressions / hour (15-minute interval = 900,000 ms)
  // High: Exactly 6 impressions / hour (10-minute interval = 600,000 ms)
  const HOURLY_CONFIG = {
    low: {
      maxPerHour: 2,
      intervalMs: 1800000, // 30 min
      label: 'Low'
    },
    balanced: {
      maxPerHour: 4,
      intervalMs: 900000,  // 15 min
      label: 'Balanced'
    },
    high: {
      maxPerHour: 6,
      intervalMs: 600000,  // 10 min
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
    intervalMs: 900000,
    hourlyLimit: 4
  };

  let scheduleTimer = null;
  let activeAdElement = null;
  let activeCountdownTimer = null;
  let localCooldownUntil = 0; // Timestamp when next ad is permitted after close or view
  let cachedDashboardSession = null; // In-memory cached session from dashboard bridge

  /**
   * Safe wrapper around browser messaging.
   * Protects against "Extension context invalidated" errors across service worker recycles.
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
   * Initialize tab configuration and check hourly eligibility
   */
  async function init() {
    try {
      // 1. Warm start from storage
      if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
        browserAPI.storage.local.get(['intensity', 'masterEnabled', 'pausedDomains', 'authUser', 'ad_cooldown_until'], (stored) => {
          if (stored) {
            if (stored.intensity && HOURLY_CONFIG[stored.intensity]) {
              config.intensity = stored.intensity;
              config.intervalMs = HOURLY_CONFIG[stored.intensity].intervalMs;
              config.hourlyLimit = HOURLY_CONFIG[stored.intensity].maxPerHour;
            }
            if (typeof stored.masterEnabled === 'boolean') {
              config.masterEnabled = stored.masterEnabled;
            }
            if (Array.isArray(stored.pausedDomains)) {
              config.isDomainPaused = stored.pausedDomains.includes(currentDomain);
            }
            if (stored.ad_cooldown_until && typeof stored.ad_cooldown_until === 'number') {
              localCooldownUntil = Math.max(localCooldownUntil, stored.ad_cooldown_until);
            }
            config.hasAuthUser = Boolean(stored.authUser && stored.authUser.id);
            config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
          }
        });
      }

      // 2. Query background service worker for authoritative tab status & hourly eligibility
      const response = await safeSendMessage({
        action: 'CHECK_TAB_STATUS',
        payload: { domain: currentDomain }
      });

      if (response && response.success) {
        config = { ...config, ...response };
        if (response.intensity && HOURLY_CONFIG[response.intensity]) {
          config.intensity = response.intensity;
          config.intervalMs = HOURLY_CONFIG[response.intensity].intervalMs;
          config.hourlyLimit = HOURLY_CONFIG[response.intensity].maxPerHour;
        }
        config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);

        if (config.isOperational) {
          if (response.canShowNow && Date.now() >= localCooldownUntil) {
            // Can show ad right now
            scheduleNextAd(1500); // 1.5s initial settle delay
          } else {
            // Schedule for the remaining wait duration
            const waitMs = Math.max(5000, Math.max(response.nextDelayMs || 0, localCooldownUntil - Date.now()));
            scheduleNextAd(waitMs);
          }
        } else {
          clearTimersAndAd();
        }
      }
    } catch (err) {
      console.debug('[Surfkit Content] Initialization delay:', err.message);
    }
  }

  /**
   * Schedule the next periodic attention ad based on strict hourly interval
   */
  function scheduleNextAd(delayMs) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;

    if (!config.hasAuthUser || !config.isOperational || !config.masterEnabled || config.isDomainPaused) {
      return;
    }

    const waitTime = typeof delayMs === 'number' ? delayMs : config.intervalMs;

    scheduleTimer = setTimeout(async () => {
      // Re-verify with background service worker to enforce strict hourly limits
      const statusRes = await safeSendMessage({
        action: 'CHECK_TAB_STATUS',
        payload: { domain: currentDomain }
      });

      if (statusRes && statusRes.success) {
        config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && statusRes.isOperational);
        config.masterEnabled = statusRes.masterEnabled;
        config.isDomainPaused = statusRes.isDomainPaused;

        if (statusRes.canShowNow && Date.now() >= localCooldownUntil) {
          if (document.visibilityState === 'visible' && !activeAdElement) {
            renderFloatingAd({ simulated: false });
            return;
          }
        }
        // If limit reached, paused, or tab hidden, reschedule for the recommended next delay
        const nextDelay = Math.max(10000, statusRes.nextDelayMs || config.intervalMs);
        scheduleNextAd(nextDelay);
      }
    }, waitTime);
  }

  /**
   * Clear all pending timers and remove active ad slice
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
   * Render isolated floating ad slice card via Shadow DOM in the BOTTOM-RIGHT corner.
   * Compact 300x250 wrapped container, clean header with SURFKIT branding + close button ONLY.
   */
  function renderFloatingAd(options = {}) {
    // Guard: only render when operational, logged in, and no active ad is visible
    if (!options.simulated && (!config.hasAuthUser || !config.isOperational || activeAdElement)) {
      return;
    }
    if (options.simulated && activeAdElement) {
      try { activeAdElement.remove(); } catch (e) {}
      activeAdElement = null;
    }

    // Host element strictly anchored to the BOTTOM-RIGHT corner
    const host = document.createElement('div');
    host.id = 'surfkit-ad-slice-host';
    host.style.position = 'fixed';
    host.style.bottom = '20px';
    host.style.right = '20px';
    host.style.width = '300px';
    host.style.height = '280px';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'auto';
    host.style.colorScheme = 'dark';

    // Attach open Shadow DOM for complete CSS isolation from the host page
    const shadow = host.attachShadow({ mode: 'open' });

    // Scoped Stylesheet for the Compact Bottom-Right Card
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
        height: 280px;
        background: #0c121e;
        border: 1px solid #1e2d42;
        border-radius: 10px;
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(0, 210, 147, 0.22);
        color: #e2e8f0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        animation: surfkitSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        transition: transform 0.22s ease, opacity 0.22s ease;
      }
      @keyframes surfkitSlideIn {
        from {
          opacity: 0;
          transform: translateY(20px) scale(0.96);
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
        height: 28px;
        padding: 0 8px;
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
        width: 16px;
        height: 16px;
        background: linear-gradient(135deg, #00d293, #06b6d4);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 9px;
        color: #0b111d;
      }
      .brand-title {
        font-size: 11px;
        font-weight: 800;
        color: #ffffff;
        letter-spacing: 0.6px;
        text-transform: uppercase;
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
        width: 300px;
        height: 250px;
        background: #090e17;
        overflow: hidden;
        position: relative;
        flex-shrink: 0;
      }
      .ad-mockup-frame, .aads-frame {
        width: 300px;
        height: 250px;
        border: 0;
        display: block;
        background: transparent;
      }
      .progress-track {
        height: 2px;
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

    // HTML Structure: Header has ONLY branding and close button. ZERO cash/earning badge.
    const card = document.createElement('div');
    card.className = 'surfkit-card';
    card.innerHTML = `
      <div class="surfkit-header">
        <div class="brand-group">
          <div class="logo-pill">S</div>
          <span class="brand-title">SURFKIT</span>
        </div>
        <button class="close-btn" id="close-btn" title="Dismiss Ad Slice" aria-label="Close">&times;</button>
      </div>
      <div class="surfkit-body">
        <iframe class="ad-mockup-frame"
                src="https://surfkit.cloud/ad-frame"
                title="Surfkit Sponsored Partner Mockup Frame"
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

    // Attention verification timer (5 seconds active visible attention)
    const durationMs = 5000;
    const intervalTick = 50;
    let elapsedMs = 0;
    let rewardDispatched = false;

    const progressFill = shadow.getElementById('progress-fill');
    const closeBtn = shadow.getElementById('close-btn');

    /**
     * Dismiss the ad card and enforce strict cooldown until the next scheduled interval
     */
    function dismissAd(wasCompleted) {
      if (activeCountdownTimer) {
        clearInterval(activeCountdownTimer);
        activeCountdownTimer = null;
      }

      // Enforce cooldown: do NOT pop up again until the full scheduled interval has elapsed
      localCooldownUntil = Date.now() + config.intervalMs;
      if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
        browserAPI.storage.local.set({ ad_cooldown_until: localCooldownUntil }).catch(() => {});
      }

      if (host && host.parentNode) {
        card.style.opacity = '0';
        card.style.transform = 'translateY(15px) scale(0.96)';
        setTimeout(() => {
          if (host.parentNode) host.parentNode.removeChild(host);
          activeAdElement = null;
          // Reschedule next check strictly after the full interval
          scheduleNextAd(config.intervalMs);
        }, 220);
      } else {
        activeAdElement = null;
        scheduleNextAd(config.intervalMs);
      }
    }

    // Manual close action: immediately dismiss without reward, start full interval cooldown
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissAd(false);
    });

    activeCountdownTimer = setInterval(() => {
      // Pause countdown if user minimizes or switches away from the active tab
      if (document.visibilityState !== 'visible') return;

      elapsedMs += intervalTick;
      const progressPercent = Math.min(100, (elapsedMs / durationMs) * 100);
      if (progressFill) progressFill.style.width = progressPercent + '%';

      if (elapsedMs >= durationMs && !rewardDispatched) {
        rewardDispatched = true;
        clearInterval(activeCountdownTimer);
        activeCountdownTimer = null;

        // Notify background for impression frequency pacing
        safeSendMessage({
          action: 'RECORD_AD_IMPRESSION',
          payload: {
            domain: currentDomain,
            website_domain: currentDomain
          }
        }, (res) => {
          if (res && res.success) {
            console.log('[Surfkit Content] Ad display completed cleanly.');
          }
        });

        // Smoothly dismiss 1.2s after completion
        setTimeout(() => {
          dismissAd(true);
        }, 1200);
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
        case 'GET_ACTIVE_DASHBOARD_SESSION': {
          if (cachedDashboardSession && cachedDashboardSession.user) {
            sendResponse({ success: true, session: cachedDashboardSession });
            return true;
          }
          // Request session from web page window
          window.postMessage({ type: 'SURFKIT_PAGE_GET_AUTH_SESSION' }, '*');
          let responded = false;
          const timeoutId = setTimeout(() => {
            if (!responded) {
              responded = true;
              sendResponse({ success: false, error: 'Dashboard session query timeout' });
            }
          }, 600);

          const replyHandler = (e) => {
            if (e.source !== window || !e.data || e.data.type !== 'SURFKIT_AUTH_SESSION_UPDATE') return;
            if (!responded) {
              responded = true;
              clearTimeout(timeoutId);
              window.removeEventListener('message', replyHandler);
              cachedDashboardSession = e.data.session;
              sendResponse({ success: true, session: e.data.session });
            }
          };
          window.addEventListener('message', replyHandler);
          return true;
        }

        case 'INJECT_AD_UNIT': {
          renderFloatingAd({ simulated: true });
          sendResponse({ success: true, message: 'Ad slice injected' });
          break;
        }

        case 'INTENSITY_CHANGED': {
          if (payload && payload.intensity && HOURLY_CONFIG[payload.intensity]) {
            const setting = HOURLY_CONFIG[payload.intensity];
            config.intensity = payload.intensity;
            config.intervalMs = setting.intervalMs;
            config.hourlyLimit = setting.maxPerHour;

            // If no ad is showing, reschedule for the new interval
            if (!activeAdElement && config.isOperational) {
              const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
              scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
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
          if (payload && payload.intensity && HOURLY_CONFIG[payload.intensity]) {
            config.intensity = payload.intensity;
            config.intervalMs = HOURLY_CONFIG[payload.intensity].intervalMs;
            config.hourlyLimit = HOURLY_CONFIG[payload.intensity].maxPerHour;
          }

          config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);

          // If turned off or signed out, immediately hide card and cancel timers
          if (!config.isOperational) {
            clearTimersAndAd();
          } else if (!scheduleTimer && !activeAdElement) {
            const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
            scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
          }
          break;
        }

        case 'DOMAIN_STATUS_CHANGED': {
          if (payload && payload.domain === currentDomain) {
            config.isDomainPaused = payload.isPaused;
            config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);

            if (!config.isOperational) {
              clearTimersAndAd();
            } else if (!scheduleTimer && !activeAdElement) {
              const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
              scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
            }
          }
          break;
        }

        case 'AUTH_SIGN_OUT': {
          cachedDashboardSession = null;
          config.hasAuthUser = false;
          config.isOperational = false;
          clearTimersAndAd();
          try {
            if (window.location && (window.location.hostname === 'surfkit.cloud' || window.location.hostname.endsWith('.surfkit.cloud'))) {
              try { localStorage.removeItem('sb-kpvrewhmnrifsnkgswdt-auth-token'); } catch (_) {}
              try { localStorage.removeItem('surfkit_ext_auth_user'); } catch (_) {}
              try { window.postMessage({ type: 'SURFKIT_POPUP_SIGN_OUT' }, window.location.origin || '*'); } catch (_) {}
            }
          } catch (_) {}
          sendResponse({ success: true });
          break;
        }
      }
      return true;
    });
  }

  // Storage changes synchronization
  if (browserAPI && browserAPI.storage && browserAPI.storage.onChanged) {
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;

      if (changes.intensity && changes.intensity.newValue && HOURLY_CONFIG[changes.intensity.newValue]) {
        const val = changes.intensity.newValue;
        config.intensity = val;
        config.intervalMs = HOURLY_CONFIG[val].intervalMs;
        config.hourlyLimit = HOURLY_CONFIG[val].maxPerHour;
        if (!activeAdElement && config.isOperational) {
          const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
          scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
        }
      }

      if (changes.masterEnabled && typeof changes.masterEnabled.newValue === 'boolean') {
        config.masterEnabled = changes.masterEnabled.newValue;
        config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
        if (!config.isOperational) {
          clearTimersAndAd();
        } else if (!scheduleTimer && !activeAdElement) {
          const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
          scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
        }
      }

      if (changes.pausedDomains && Array.isArray(changes.pausedDomains.newValue)) {
        config.isDomainPaused = changes.pausedDomains.newValue.includes(currentDomain);
        config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
        if (!config.isOperational) {
          clearTimersAndAd();
        } else if (!scheduleTimer && !activeAdElement) {
          const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
          scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
        }
      }

      if (changes.authUser) {
        config.hasAuthUser = Boolean(changes.authUser.newValue && changes.authUser.newValue.id);
        config.isOperational = Boolean(ENABLE_EXTERNAL_AD_INJECTION && config.hasAuthUser && config.masterEnabled && !config.isDomainPaused);
        if (!config.isOperational) {
          clearTimersAndAd();
        } else if (!scheduleTimer && !activeAdElement) {
          const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
          scheduleNextAd(Math.max(remainingCooldown, config.intervalMs));
        }
      }
    });
  }

  // Window bridge for web dashboard communication (surfkit.cloud)
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;
    const { type, action, payload, session } = event.data;

    if (type === 'SURFKIT_AUTH_SYNC') {
      try {
        const isTrustedOrigin = event.origin === 'https://surfkit.cloud' || event.origin === window.location.origin;
        if (!isTrustedOrigin) return;

        if (event.data.event === 'SIGNED_IN' && session && (session.access_token || session.user)) {
          cachedDashboardSession = session;
          config.hasAuthUser = Boolean(session.user && session.user.id);
          try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              chrome.storage.local.set({
                surfkit_session: session,
                supabase_session: session,
                authUser: session.user || null,
                surfkit_auth_user: session.user || null,
                supabaseUserId: (session.user && session.user.id) ? session.user.id : null,
                isExplicitSignOut: false
              });
            }
          } catch (_) {}
          safeSendMessage({
            action: 'AUTH_SET_SESSION_TOKENS',
            payload: session
          });
        } else if (event.data.event === 'SIGNED_OUT') {
          cachedDashboardSession = null;
          config.hasAuthUser = false;
          try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              chrome.storage.local.remove(['surfkit_session', 'supabase_session', 'authUser', 'surfkit_auth_user', 'supabaseUserId']);
              chrome.storage.local.set({ isExplicitSignOut: true });
            }
          } catch (_) {}
          safeSendMessage({ action: 'AUTH_SIGN_OUT' });
        }
      } catch (_) {}
      return;
    }

    if (type === 'SURFKIT_AUTH_SESSION_UPDATE') {
      const sess = session || payload;
      if (sess && (sess.user || sess.access_token)) {
        cachedDashboardSession = sess;
        config.hasAuthUser = Boolean(sess.user && sess.user.id);
        safeSendMessage({
          action: 'AUTH_SET_SESSION_TOKENS',
          payload: sess
        });
      }
    } else if (type === 'SURFKIT_AUTH_SESSION_CLEAR' || type === 'SURFKIT_USER_SIGNED_OUT') {
      cachedDashboardSession = null;
      config.hasAuthUser = false;
      safeSendMessage({ action: 'AUTH_SIGN_OUT' });
    } else if (type === 'SURFKIT_PAGE_GET_STATE') {
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

  // Sync initial localStorage Supabase auth token on surfkit.cloud page load
  try {
    if (window.location && (window.location.hostname === 'surfkit.cloud' || window.location.hostname.endsWith('.surfkit.cloud'))) {
      const rawSupa = localStorage.getItem('sb-kpvrewhmnrifsnkgswdt-auth-token');
      if (rawSupa) {
        const parsed = JSON.parse(rawSupa);
        const sess = (parsed && parsed.currentSession) ? parsed.currentSession : parsed;
        if (sess && sess.access_token && sess.user && sess.user.email) {
          const normSess = {
            access_token: sess.access_token,
            refresh_token: sess.refresh_token || null,
            expires_at: sess.expires_at || null,
            user: sess.user
          };
          cachedDashboardSession = normSess;
          config.hasAuthUser = Boolean(sess.user && sess.user.id);
          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({
              surfkit_session: normSess,
              supabase_session: normSess,
              authUser: sess.user,
              surfkit_auth_user: sess.user,
              supabaseUserId: sess.user.id || null,
              isExplicitSignOut: false
            });
          }
          safeSendMessage({
            action: 'AUTH_SET_SESSION_TOKENS',
            payload: normSess
          });
        }
      }
    }
  } catch (_) {}

  // Request active auth session and announce live state to web page on injection
  try {
    window.postMessage({ type: 'SURFKIT_PAGE_GET_AUTH_SESSION' }, '*');
  } catch (e) {}

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

  // Visibility change listener to resume checks when user returns to tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (config.isOperational && !scheduleTimer && !activeAdElement) {
        const remainingCooldown = Math.max(0, localCooldownUntil - Date.now());
        scheduleNextAd(Math.max(remainingCooldown, 2000));
      }
    }
  });

  // Execute initialization
  init();
})();
