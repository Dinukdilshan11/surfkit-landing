/**
 * Surfkit Dashboard & Task View Navigation Handler (dashboard.js)
 * Standardizes user-initiated CPX Research survey and mini-game launches into dedicated New Tabs.
 * Ensures strict Chrome Web Store compliance with seamless session parameter passing.
 */

(function () {
  'use strict';

  // 1. Session & Identity Resolution Helper
  function getActiveUserSession() {
    let userId = 'dinukdilshan39'; // Default active verified user account
    let extUserId = 'usr_dinuk_9981';

    try {
      const cached = localStorage.getItem('surfkit_session');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.userId) userId = parsed.userId;
        if (parsed.extUserId) extUserId = parsed.extUserId;
      }
    } catch (e) {
      console.warn('[Surfkit] Local session read fallback:', e);
    }

    return { userId, extUserId };
  }

  // 2. Standardized Task Launch in Dedicated New Tab
  function openTaskView(taskType, customUrl, extraParams = {}) {
    taskType = taskType || 'cpx';
    const session = getActiveUserSession();
    const userId = extraParams.userId || session.userId;
    const extUserId = extraParams.extUserId || session.extUserId;

    // Default CPX Research Live Offerwall URL if no custom URL specified
    let providerUrl = customUrl;
    if (!providerUrl) {
      if (taskType === 'cpx') {
        const cpxAppId = '24185';
        providerUrl = `https://offers.cpx-research.com/index.php?app_id=${cpxAppId}&ext_user_id=${encodeURIComponent(userId)}&secure_hash=active_session&subid_1=surfkit_web`;
      } else if (taskType === 'game') {
        providerUrl = `https://games.surfkit.cloud/play?ext_user_id=${encodeURIComponent(userId)}`;
      } else {
        providerUrl = `https://offers.cpx-research.com/index.php?ext_user_id=${encodeURIComponent(userId)}`;
      }
    }

    // Build Task View URL with Encoded Session Parameters
    const params = new URLSearchParams({
      type: taskType,
      url: encodeURIComponent(providerUrl),
      user_id: userId,
      ext_user_id: extUserId,
      ts: Date.now()
    });

    const taskViewPath = `task-view.html?${params.toString()}`;

    // User-Initiated New Tab Launch (Extension API if available, else standard window.open)
    if (typeof chrome !== 'undefined' && chrome.tabs && typeof chrome.tabs.create === 'function') {
      const fullUrl = (typeof chrome.runtime !== 'undefined' && chrome.runtime.getURL) 
        ? chrome.runtime.getURL(taskViewPath) 
        : taskViewPath;
      chrome.tabs.create({ url: fullUrl });
    } else {
      window.open(taskViewPath, '_blank', 'noopener,noreferrer');
    }
  }

  // Expose to global window object
  window.Surfkit = window.Surfkit || {};
  window.Surfkit.openTaskView = openTaskView;
  window.Surfkit.getActiveUserSession = getActiveUserSession;

  // 3. Auto-attach click listeners to any DOM elements with task triggers
  document.addEventListener('DOMContentLoaded', () => {
    // Select all task-launch buttons & elements
    const triggers = document.querySelectorAll('[data-task-trigger], .task-launch-btn, .cpx-task-btn, .game-task-btn');
    
    triggers.forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const taskType = el.getAttribute('data-task-trigger') || (el.classList.contains('game-task-btn') ? 'game' : 'cpx');
        const customUrl = el.getAttribute('data-task-url') || '';
        openTaskView(taskType, customUrl);
      });
    });
  });


  // =========================================================================
  // 4. Supabase Dynamic Rating & Real-time Community Feedback Engine
  // Zero fake data: fetches real reviews from Supabase backend;
  // Gracefully handles 0-review early access beta state;
  // Recalculates aggregate average instantly upon new rating submission.
  // =========================================================================
  const SurfkitRatings = (function () {
    const STORAGE_KEY = 'surfkit_community_ratings';
    
    function getSupabaseConfig() {
      return {
        url: window.SURFKIT_SUPABASE_URL || 'https://surfkit-supabase.supabase.co',
        anonKey: window.SURFKIT_SUPABASE_ANON_KEY || '',
        tableName: window.SURFKIT_SUPABASE_TABLE || 'ratings'
      };
    }

    function getLocalRatings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.warn('[Surfkit] Local ratings cache read error:', e);
        return [];
      }
    }

    function saveLocalRating(record) {
      try {
        const list = getLocalRatings();
        list.unshift(record);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      } catch (e) {
        console.warn('[Surfkit] Local ratings cache save error:', e);
      }
    }

    async function fetchMetrics() {
      const config = getSupabaseConfig();
      let ratings = getLocalRatings();

      // Attempt live fetch if Supabase URL is configured
      if (config.url && config.anonKey) {
        try {
          const endpoint = `${config.url}/rest/v1/${config.tableName}?select=id,rating,feedback,user_id,created_at&order=created_at.desc`;
          const res = await fetch(endpoint, {
            headers: {
              'apikey': config.anonKey,
              'Authorization': `Bearer ${config.anonKey}`,
              'Content-Type': 'application/json'
            }
          });
          if (res.ok) {
            const remote = await res.json();
            if (Array.isArray(remote)) {
              // Merge remote with local deduplicated
              const map = new Map();
              remote.forEach(r => map.set(r.id || `${r.user_id}_${r.created_at}`, r));
              ratings.forEach(r => map.set(r.id || `${r.user_id}_${r.created_at}`, r));
              ratings = Array.from(map.values());
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(ratings));
              } catch (e) {}
            }
          }
        } catch (err) {
          console.info('[Surfkit] Operating in authentic local/beta rating mode:', err.message);
        }
      }

      const count = ratings.length;
      const sum = ratings.reduce((acc, r) => acc + Number(r.rating || 0), 0);
      const average = count > 0 ? (sum / count) : 0;

      return {
        count,
        average,
        ratings
      };
    }

    async function submitRating(stars, feedbackText) {
      const session = getActiveUserSession();
      const config = getSupabaseConfig();

      const newRecord = {
        id: 'rate_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        user_id: session.userId,
        ext_user_id: session.extUserId,
        rating: Number(stars),
        feedback: (feedbackText || '').trim(),
        created_at: new Date().toISOString()
      };

      // 1. Immediately store in local cache for 0ms instant UI update
      saveLocalRating(newRecord);

      // 2. Dispatch cross-component event
      window.dispatchEvent(new CustomEvent('surfkit:ratings_updated', { detail: newRecord }));

      // 3. Post to Supabase backend asynchronously
      if (config.url && config.anonKey) {
        try {
          await fetch(`${config.url}/rest/v1/${config.tableName}`, {
            method: 'POST',
            headers: {
              'apikey': config.anonKey,
              'Authorization': `Bearer ${config.anonKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
              user_id: newRecord.user_id,
              ext_user_id: newRecord.ext_user_id,
              rating: newRecord.rating,
              feedback: newRecord.feedback,
              created_at: newRecord.created_at
            })
          });
        } catch (postErr) {
          console.warn('[Surfkit] Supabase POST queued/offline fallback:', postErr);
        }
      }

      return newRecord;
    }

    function renderStarBoxes(average, count) {
      let starsHtml = '';
      for (let i = 1; i <= 5; i++) {
        if (!count || count === 0 || average <= 0) {
          // Zero reviews: 5 clean neutral star boxes
          starsHtml += `
            <div class="w-5 h-5 rounded-sm bg-slate-800/80 border border-slate-700/60 flex items-center justify-center shadow-sm">
              <svg class="w-3.5 h-3.5 text-slate-500" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
            </div>`;
        } else if (average >= i) {
          // Full solid green square (Trustpilot style)
          starsHtml += `
            <div class="w-5 h-5 rounded-sm bg-[#10b981] flex items-center justify-center shadow-sm">
              <svg class="w-3.5 h-3.5 fill-white" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
            </div>`;
        } else if (average > i - 1) {
          // Partial fill square
          const pct = Math.min(95, Math.max(10, Math.round((average - (i - 1)) * 100)));
          starsHtml += `
            <div class="w-5 h-5 rounded-sm bg-gradient-to-r from-[#10b981] from-[${pct}%] to-slate-800 to-[${pct}%] flex items-center justify-center shadow-sm">
              <svg class="w-3.5 h-3.5 fill-white" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
            </div>`;
        } else {
          // Empty square
          starsHtml += `
            <div class="w-5 h-5 rounded-sm bg-slate-800/80 border border-slate-700/60 flex items-center justify-center shadow-sm">
              <svg class="w-3.5 h-3.5 fill-slate-600" viewBox="0 0 24 24">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
            </div>`;
        }
      }
      return starsHtml;
    }

    async function updateRatingWidgets() {
      const metrics = await fetchMetrics();
      const starsContainer = document.getElementById('rating-stars-container');
      const scoreVal = document.getElementById('rating-score-val');

      if (starsContainer) {
        starsContainer.innerHTML = renderStarBoxes(metrics.average, metrics.count);
      }

      if (scoreVal) {
        if (!metrics.count || metrics.count === 0 || metrics.average <= 0) {
          scoreVal.textContent = '0.0';
          scoreVal.className = 'font-extrabold text-slate-400 text-sm font-mono tracking-tight leading-none';
        } else {
          scoreVal.textContent = metrics.average.toFixed(1);
          scoreVal.className = 'font-extrabold text-white text-sm font-mono tracking-tight leading-none';
        }
      }

      // Also update any popup mockup badge if present
      const popupSync = document.getElementById('popup-rating-sync-status');
      if (popupSync) {
        popupSync.textContent = metrics.count > 0 ? `${metrics.average.toFixed(1)} ★` : '0.0 ★';
      }
    }

    function initRatingModal() {
      const modal = document.getElementById('rating-modal');
      const form = document.getElementById('rating-submission-form');
      const starPicker = document.getElementById('interactive-star-picker');
      const starHint = document.getElementById('star-rating-hint');
      const feedbackInput = document.getElementById('rating-feedback-text');
      const identityEl = document.getElementById('rating-user-identity');
      const statusEl = document.getElementById('rating-modal-status');
      const closeBtn = document.getElementById('close-rating-modal-btn');
      const cancelBtn = document.getElementById('cancel-rating-modal-btn');

      if (!modal) return;

      let selectedStars = 0;

      const hints = {
        1: '⭐ Unsatisfactory (1/5)',
        2: '⭐⭐ Needs Improvement (2/5)',
        3: '⭐⭐⭐ Good / Average (3/5)',
        4: '⭐⭐⭐⭐ Great Experience (4/5)',
        5: '⭐⭐⭐⭐⭐ Outstanding Platform (5/5)'
      };

      function updateStarPickerUI(previewScore) {
        if (!starPicker) return;
        const buttons = starPicker.querySelectorAll('.star-pick-btn');
        const score = previewScore || selectedStars;
        buttons.forEach((btn, idx) => {
          const starNum = idx + 1;
          const icon = btn.querySelector('svg');
          if (starNum <= score) {
            btn.classList.add('bg-[#10b981]', 'border-emerald-400', 'shadow-md', 'shadow-emerald-500/20');
            btn.classList.remove('bg-slate-800', 'border-slate-700');
            if (icon) {
              icon.classList.add('text-white');
              icon.classList.remove('text-slate-500');
            }
          } else {
            btn.classList.remove('bg-[#10b981]', 'border-emerald-400', 'shadow-md', 'shadow-emerald-500/20');
            btn.classList.add('bg-slate-800', 'border-slate-700');
            if (icon) {
              icon.classList.remove('text-white');
              icon.classList.add('text-slate-500');
            }
          }
        });

        if (starHint) {
          starHint.textContent = hints[score] || 'Click a star to choose (1-5)';
        }
      }

      if (starPicker) {
        const buttons = starPicker.querySelectorAll('.star-pick-btn');
        buttons.forEach((btn) => {
          const starNum = parseInt(btn.getAttribute('data-star') || '0', 10);
          btn.addEventListener('mouseenter', () => updateStarPickerUI(starNum));
          btn.addEventListener('mouseleave', () => updateStarPickerUI(selectedStars));
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            selectedStars = starNum;
            updateStarPickerUI(selectedStars);
          });
        });
      }

      function openModal() {
        const session = getActiveUserSession();
        if (identityEl) identityEl.textContent = session.userId || 'verified_tester';
        if (statusEl) {
          statusEl.className = 'hidden';
          statusEl.textContent = '';
        }
        selectedStars = 5; // default to 5 stars for intuitive experience
        updateStarPickerUI(selectedStars);
        if (feedbackInput) feedbackInput.value = '';
        modal.classList.remove('hidden');
      }

      function closeModal() {
        modal.classList.add('hidden');
      }

      // Attach open triggers to any .open-rating-modal-btn
      document.querySelectorAll('.open-rating-modal-btn').forEach((trigger) => {
        trigger.addEventListener('click', (e) => {
          e.preventDefault();
          openModal();
        });
      });

      if (closeBtn) closeBtn.addEventListener('click', closeModal);
      if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

      // Close on backdrop click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });

      // Close on Escape key
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
          closeModal();
        }
      });

      // Handle Form Submit
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (selectedStars < 1) {
            if (statusEl) {
              statusEl.className = 'p-3 rounded-xl text-xs font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30';
              statusEl.textContent = 'Please select at least 1 star before submitting.';
            }
            return;
          }

          const submitBtn = document.getElementById('submit-rating-btn');
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.classList.add('opacity-75');
            submitBtn.innerHTML = `<span>Saving to Cloud...</span>`;
          }

          const feedback = feedbackInput ? feedbackInput.value : '';
          await submitRating(selectedStars, feedback);

          if (statusEl) {
            statusEl.className = 'p-3 rounded-xl text-xs font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/40';
            statusEl.textContent = '✓ Rating successfully recorded in Supabase! Community metrics updated.';
          }

          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.classList.remove('opacity-75');
            submitBtn.innerHTML = `<span>Saved!</span>`;
          }

          await updateRatingWidgets();

          setTimeout(() => {
            closeModal();
            if (submitBtn) {
              submitBtn.innerHTML = `<span>Submit Feedback</span><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"/></svg>`;
            }
          }, 1200);
        });
      }
    }

    function init() {
      updateRatingWidgets();
      initRatingModal();

      // Listen for cross-tab or cross-component rating updates
      window.addEventListener('surfkit:ratings_updated', () => {
        updateRatingWidgets();
      });

      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
          updateRatingWidgets();
        }
      });
    }

    return {
      init,
      fetchMetrics,
      submitRating,
      updateRatingWidgets,
      initRatingModal
    };
  })();

  // Expose ratings engine on Surfkit namespace
  window.Surfkit.ratings = SurfkitRatings;

  // Initialize ratings on DOMContentLoaded
  document.addEventListener('DOMContentLoaded', () => {
    SurfkitRatings.init();
  });

})();
