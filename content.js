/**
 * Surfkit - Injected Content Script (Manifest V3)
 * Ad injection system REMOVED. This script only relays extension state to
 * dashboard pages and handles page-to-extension messaging.
 */
(function () {
  'use strict';

  if (window.__SURFKIT_CONTENT_LOADED__) return;
  window.__SURFKIT_CONTENT_LOADED__ = true;

  // Cross-browser runtime adapter
  const browserAPI = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

  // ── Relay background → page (STATE_CHANGED broadcast) ──────────────
  browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { action, payload } = message || {};

    switch (action) {
      case 'STATE_CHANGED': {
        const broadcastData = payload || message.data;
        try {
          window.postMessage({ type: 'SURFKIT_EXTENSION_STATE_UPDATE', data: broadcastData }, '*');
        } catch (e) {}
        if (broadcastData && 'authUser' in broadcastData) {
          // no-op: auth handled by background
        }
        sendResponse({ success: true });
        break;
      }
      default:
        break;
    }
    return true; // keep channel open for async
  });

  // ── Relay page → background (SURFKIT_PAGE_* messages) ──────────────
  window.addEventListener('message', async (event) => {
    if (!event.data || !event.data.type) return;
    const { type, action, payload } = event.data;

    if (type === 'SURFKIT_PAGE_GET_STATE') {
      try {
        const response = await new Promise((resolve) =>
          browserAPI.runtime.sendMessage({ action: 'GET_STATE' }, resolve)
        );
        if (response && response.success && response.data) {
          window.postMessage({ type: 'SURFKIT_EXTENSION_STATE_UPDATE', data: response.data }, '*');
        }
      } catch (err) {}
    } else if (type === 'SURFKIT_PAGE_ACTION') {
      try {
        await new Promise((resolve) =>
          browserAPI.runtime.sendMessage({ action, payload }, resolve)
        );
        const res = await new Promise((resolve) =>
          browserAPI.runtime.sendMessage({ action: 'GET_STATE' }, resolve)
        );
        if (res && res.success && res.data) {
          window.postMessage({ type: 'SURFKIT_EXTENSION_STATE_UPDATE', data: res.data }, '*');
        }
      } catch (err) {}
    }
  });

  // ── Announce live state on injection ───────────────────────────────
  try {
    browserAPI.runtime.sendMessage({ action: 'GET_STATE' }, (res) => {
      if (res && res.success && res.data) {
        window.postMessage({ type: 'SURFKIT_EXTENSION_STATE_UPDATE', data: res.data }, '*');
      }
    });
  } catch (e) {}
})();
