/**
 * Surfkit - Background Service Worker (Manifest V3)
 * Full Supabase v2 Integration:
 * - Real-time authentication via Supabase Auth
 * - Data strictly isolated by auth.uid()
 * - Live logging of ad impressions to 'ad_impressions' and 'profiles'
 * - Realtime subscriptions for instant cloud sync
 * - ZERO mock counters or fake tickers
 */

// Import official Supabase JS v2 bundle and adapter
importScripts('supabase.min.js', 'supabase-client.js');

// Feature flag: ad-network compliance & dashboard-only rewards model
const ENABLE_EXTERNAL_AD_INJECTION = false;


const DEFAULT_STATE = {
  masterEnabled: true,
  isExplicitSignOut: false,
  intensity: 'balanced', // 'low' | 'balanced' | 'high'
  hourlyLimits: {
    low: 2,        // Exactly 2 impressions / hour
    balanced: 4,   // Exactly 4 impressions / hour
    high: 6        // Exactly 6 impressions / hour
  },
  // Exact hourly intervals: Low = 30m, Balanced = 15m, High = 10m
  adIntervals: {
    low: 1800000,     // 30 min (2 / hr)
    balanced: 900000, // 15 min (4 / hr)
    high: 600000      // 10 min (6 / hr)
  },
  multipliers: {
    low: 1.0,
    balanced: 1.2,
    high: 2.0
  },
  geoTier: 3,         // Default Tier 3 (e.g. LK / Sri Lanka)
  countryCode: 'LK',
  countryName: 'Sri Lanka',
  geoTierRates: {
    1: 0.0025,  // Tier 1 (USA, UK, etc.): ~$0.0025 per ad view
    2: 0.0010,  // Tier 2 (Growth markets): ~$0.0010 per ad view
    3: 0.0003,  // Tier 3 (LK / Sri Lanka, IN, etc.): ~$0.0003 per ad view
    4: 0.00015  // Tier 4 (Rest of World): ~$0.00015 per ad view
  },
  recentImpressionTimestamps: [],
  balanceUsd: 0.000,
  dailyEarnings: 0.000,
  tokensEarned: 0,
  tokenSymbol: 'SKIT',
  conversionRate: 0.001,  // 1 SKIT = $0.001 USD
  baseRewardPerAd: 0.024, // $0.024 base
  adsSeenToday: 0,
  activeStreakDays: 0,
  earningVelocityPerHour: 0.00,
  pausedDomains: [],
  lastActiveDate: null,
  stats: {
    totalImpressions: 0,
    lifetimeEarnedUsd: 0.000,
    sessionStartTime: Date.now()
  }
};

let realtimeChannel = null;
let activeRealtimeUserId = null;

/**
 * Retrieve state merged from local storage and defaults
 */
/**
 * Calculate dynamic Daily Streak based on calendar date of last activity (UTC)
 * - Same calendar day: maintain streak
 * - Yesterday (1 day diff): increment streak by 1
 * - Missed > 1 day: reset streak to 1
 * - First activity: initialize streak to 1
 */
function calculateUpdatedStreak(lastActiveDate, currentStreak) {
  const todayStr = new Date().toISOString().split('T')[0];
  const curStreak = Number(currentStreak || 0);

  if (!lastActiveDate) {
    return { streak: 1, lastActiveDate: todayStr, isNewDay: true };
  }

  const cleanLast = String(lastActiveDate).split('T')[0];
  if (cleanLast === todayStr) {
    return { streak: Math.max(1, curStreak), lastActiveDate: todayStr, isNewDay: false };
  }

  const dLast = new Date(cleanLast + 'T00:00:00Z');
  const dToday = new Date(todayStr + 'T00:00:00Z');
  const diffDays = Math.round((dToday.getTime() - dLast.getTime()) / 86400000);

  if (diffDays === 1) {
    return { streak: Math.max(1, curStreak) + 1, lastActiveDate: todayStr, isNewDay: true };
  } else if (diffDays > 1) {
    return { streak: 1, lastActiveDate: todayStr, isNewDay: true };
  } else {
    return { streak: Math.max(1, curStreak), lastActiveDate: todayStr, isNewDay: false };
  }
}

// Geo-Tier Country Definitions & Dynamic Rate Calculations
const TIER1_COUNTRIES = ['US','CA','GB','DE','FR','IT','ES','NL','AU','NZ','CH','SE','NO','DK','IE','AT','BE','FI','LU','IS'];
const TIER2_COUNTRIES = ['AE','SA','SG','JP','KR','BR','MX','PL','TR','QA','KW','IL','TW','HK','MY','TH','ZA','CL','AR','CO','CZ','PT','GR','HU','RO'];
const TIER3_COUNTRIES = ['LK','IN','PK','BD','ID','PH','VN','EG','NG','KE','GH','MA','DZ','UA','PE','EC','NP','MM','KH'];

function resolveGeoTier(code) {
  if (!code) return 3;
  const c = String(code).toUpperCase().trim();
  if (TIER1_COUNTRIES.includes(c)) return 1;
  if (TIER2_COUNTRIES.includes(c)) return 2;
  if (TIER3_COUNTRIES.includes(c)) return 3;
  return 4;
}

const GEO_TIER_RATES = {
  1: 0.0025,  // Tier 1 (USA, UK, etc.): ~$0.0025 per ad view
  2: 0.0010,  // Tier 2 (Growth markets): ~$0.0010 per ad view
  3: 0.0003,  // Tier 3 (LK, IN, etc.): ~$0.0003 per ad view
  4: 0.00015  // Tier 4 (Rest of World): ~$0.00015 per ad view
};

function calculateGeoTierReward(state) {
  const tier = Number(state.geoTier || resolveGeoTier(state.countryCode) || 3);
  return GEO_TIER_RATES[tier] || 0.0003;
}

async function detectAndStoreGeoLocation() {
  try {
    const current = await chrome.storage.local.get(['countryCode', 'geoTier', 'countryName']);
    if (current && current.countryCode && current.geoTier) {
      return;
    }
    const res = await fetch('https://ipapi.co/json/').catch(() => null);
    let countryCode = null;
    let countryName = null;
    if (res && res.ok) {
      const d = await res.json().catch(() => null);
      if (d && d.country_code) {
        countryCode = d.country_code.toUpperCase();
        countryName = d.country_name || countryCode;
      }
    }
    if (!countryCode) {
      const fb = await fetch('https://ipwho.is/').catch(() => null);
      if (fb && fb.ok) {
        const d2 = await fb.json().catch(() => null);
        if (d2 && d2.country_code) {
          countryCode = d2.country_code.toUpperCase();
          countryName = d2.country || countryCode;
        }
      }
    }
    countryCode = countryCode || 'LK';
    const tier = resolveGeoTier(countryCode);
    await chrome.storage.local.set({
      countryCode: countryCode,
      countryName: countryName || countryCode,
      geoTier: tier
    });
  } catch (e) {}
}

async function getFullState() {
  const current = await chrome.storage.local.get(null);
  const state = { ...DEFAULT_STATE, ...(current || {}) };

  state.balanceUsd = typeof state.balanceUsd === 'number' ? state.balanceUsd : Number(state.balanceUsd || 0);
  state.dailyEarnings = typeof state.dailyEarnings === 'number' ? state.dailyEarnings : Number(state.dailyEarnings || 0);
  state.tokensEarned = typeof state.tokensEarned === 'number' ? state.tokensEarned : Number(state.tokensEarned || 0);
  state.adsSeenToday = typeof state.adsSeenToday === 'number' ? state.adsSeenToday : Number(state.adsSeenToday || 0);
  state.activeStreakDays = typeof state.activeStreakDays === 'number' ? state.activeStreakDays : Number(state.activeStreakDays || 0);
  state.lastActiveDate = state.lastActiveDate ? String(state.lastActiveDate).split('T')[0] : null;
  state.masterEnabled = typeof state.masterEnabled === 'boolean' ? state.masterEnabled : true;
  if (state.authUser || state.surfkit_auth_user) {
    state.isExplicitSignOut = false;
  }
  state.pausedDomains = Array.isArray(state.pausedDomains) ? state.pausedDomains : [];
  state.geoTier = typeof state.geoTier === 'number' ? state.geoTier : 3;
  state.countryCode = state.countryCode ? String(state.countryCode).toUpperCase() : 'LK';
  state.recentImpressionTimestamps = Array.isArray(state.recentImpressionTimestamps) ? state.recentImpressionTimestamps : [];

  return state;
}

/**
 * Synchronize extension action badge display
 */
function updateBadge(masterEnabled, balanceUsd) {
  try {
    if (!masterEnabled) {
      chrome.action.setBadgeText({ text: 'OFF' });
      chrome.action.setBadgeBackgroundColor({ color: '#475569' });
      return;
    }
    const val = typeof balanceUsd === 'number' ? balanceUsd : 0;
    const formatted = '$' + val.toFixed(2);
    chrome.action.setBadgeText({ text: formatted });
    chrome.action.setBadgeBackgroundColor({ color: '#00d293' });
  } catch (err) {
    console.warn('[Surfkit Badge] Error updating badge:', err);
  }
}

/**
 * Broadcast state update to all open tabs and extension views
 */
async function broadcastToAllTabs(payload) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://')) {
        chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[Surfkit Broadcast] Error broadcasting:', err);
  }
}

/**
 * Setup Realtime channel subscription for the active user
 */
function setupRealtimeForUser(userId) {
  if (!userId) {
    if (realtimeChannel) {
      SurfkitSupabase.unsubscribe(realtimeChannel);
      realtimeChannel = null;
    }
    activeRealtimeUserId = null;
    return;
  }

  // If already actively subscribed for this user, avoid redundant reconnects
  if (realtimeChannel && activeRealtimeUserId === userId) {
    return;
  }

  if (realtimeChannel) {
    try {
      SurfkitSupabase.unsubscribe(realtimeChannel);
    } catch (e) {}
    realtimeChannel = null;
  }

  activeRealtimeUserId = userId;

  try {
    realtimeChannel = SurfkitSupabase.subscribeToProfileChanges(userId, async (newProfile) => {
      if (!newProfile) return;
      const bal = Number(newProfile.available_balance || 0);
      const lastActive = newProfile.last_active_date ? String(newProfile.last_active_date).split('T')[0] : null;
      const daily = Number(newProfile.daily_earnings || 0);
      const tokens = Math.round(bal / 0.001);
      const dailyImpressions = Number(newProfile.daily_impressions || 0);
      const lifetimeImpressions = Number(newProfile.lifetime_impressions || 0);
      const streak = Number(newProfile.streak_days || 0);

      const updates = {
        balanceUsd: bal,
        dailyEarnings: daily,
        tokensEarned: tokens,
        adsSeenToday: dailyImpressions,
        activeStreakDays: streak,
        lastActiveDate: lastActive,
        stats: {
          totalImpressions: lifetimeImpressions,
          lifetimeEarnedUsd: Number(newProfile.lifetime_earnings || bal),
          sessionStartTime: Date.now()
        }
      };

      await chrome.storage.local.set(updates);
      const state = await getFullState();
      updateBadge(state.masterEnabled, bal);
      broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
    });
  } catch (e) {
    console.warn('[Surfkit Realtime] Setup error:', e);
  }
}

/**
 * Reconcile local state with live Supabase user profile
 */
async function syncFromSupabase() {
  try {
    const user = await SurfkitSupabase.getCurrentUser();
    if (!user) return null;

    const currentLocal = await chrome.storage.local.get([
      'masterEnabled',
      'intensity',
      'user_explicit_toggle',
      'balanceUsd',
      'tokensEarned',
      'adsSeenToday',
      'activeStreakDays',
      'stats'
    ]);

    const profile = await SurfkitSupabase.getLiveProfile(user.id, user.email);
    if (profile) {
      // Reconcile earnings: take maximum between cloud and local
      const bal = Math.max(Number(profile.availableBalance || 0), Number(currentLocal.balanceUsd || 0));
      const daily = Math.max(Number(profile.dailyEarnings || 0), Number(currentLocal.dailyEarnings || 0));
      const tokens = Math.max(Math.round(bal / 0.001), Number(currentLocal.tokensEarned || 0));
      const dailyAds = Math.max(Number(profile.dailyImpressions || 0), Number(currentLocal.adsSeenToday || 0));
      const lifetimeAds = Math.max(Number(profile.lifetimeImpressions || 0), Number(currentLocal.stats?.totalImpressions || 0));
      const streak = profile.streakDays !== undefined ? Number(profile.streakDays) : (Number(currentLocal.activeStreakDays || 0) || (dailyAds > 0 ? 1 : 0));
      const lastActive = profile.lastActiveDate || currentLocal.lastActiveDate || null;

      // Determine master status: respect user's explicit local action first
      let resolvedMaster = true;
      if (typeof currentLocal.user_explicit_toggle === 'boolean') {
        resolvedMaster = currentLocal.user_explicit_toggle;
      } else if (typeof currentLocal.masterEnabled === 'boolean') {
        resolvedMaster = currentLocal.masterEnabled;
      } else if (typeof profile.autoSurfEnabled === 'boolean') {
        resolvedMaster = profile.autoSurfEnabled;
      }

      const cloudState = {
        balanceUsd: bal,
        dailyEarnings: daily,
        tokensEarned: tokens,
        adsSeenToday: dailyAds,
        activeStreakDays: streak,
        lastActiveDate: lastActive,
        intensity: currentLocal.intensity || profile.adIntensity || 'balanced',
        masterEnabled: resolvedMaster,
        stats: {
          totalImpressions: lifetimeAds,
          lifetimeEarnedUsd: Math.max(Number(profile.lifetimeEarnings || 0), Number(currentLocal.stats?.lifetimeEarnedUsd || 0), bal),
          sessionStartTime: currentLocal.stats?.sessionStartTime || Date.now()
        }
      };

      await chrome.storage.local.set(cloudState);
      updateBadge(cloudState.masterEnabled, bal);
      setupRealtimeForUser(user.id);

      const full = await getFullState();
      broadcastToAllTabs({ action: 'STATE_CHANGED', payload: full, data: full });
      return full;
    }
  } catch (e) {
    console.warn('[Surfkit Background] Sync from Supabase error:', e);
  }
  return null;
}

/**
 * Extension Installation & Startup Handlers
 */

/**
 * Automated Midnight Reset & Archive Handler
 * Runs at UTC 00:00 (midnight) and whenever the background worker wakes.
 * Archives current totals into daily_earnings_history and resets daily counters.
 */
function getMsUntilNextUtcMidnight() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 2 // 2 seconds past UTC midnight
  ));
  return Math.max(2000, nextMidnight.getTime() - now.getTime());
}

function scheduleUtcMidnightAlarm() {
  const msUntilMidnight = getMsUntilNextUtcMidnight();
  const delayMinutes = Math.max(0.1, msUntilMidnight / 60000);
  chrome.alarms.create('surfkit_utc_midnight', { delayInMinutes: delayMinutes });
  console.log(`[Surfkit Background] Next UTC Midnight alarm set in ${delayMinutes.toFixed(1)} minutes`);
}

async function checkAndPerformDailyReset() {
  try {
    const now = new Date();
    // Strict UTC midnight check: Only trigger daily reset during the 00:00 UTC hour
    if (now.getUTCHours() !== 0) {
      return;
    }
    const todayUtc = now.toISOString().split('T')[0];
    const stored = await chrome.storage.local.get([
      'lastDailyResetDate',
      'dailyEarnings',
      'adsSeenToday',
      'lastActiveDate'
    ]);
    const lastReset = stored.lastDailyResetDate;

    if (lastReset && lastReset !== todayUtc) {
      console.log(`[Surfkit Background] Midnight crossed (${lastReset} -> ${todayUtc}). Running daily reset & archive...`);
      
      const archiveDate = stored.lastActiveDate || lastReset;
      const finalDailyEarnings = Number(stored.dailyEarnings || 0);
      const finalDailyImpressions = Number(stored.adsSeenToday || 0);

      const currentUser = await SurfkitSupabase.getCurrentUser();
      if (currentUser && currentUser.id) {
        // Archive prior day's totals and reset profiles table in Supabase
        if (typeof SurfkitSupabase.archiveAndResetDaily === 'function') {
          await SurfkitSupabase.archiveAndResetDaily(
            currentUser.id,
            archiveDate,
            finalDailyEarnings,
            finalDailyImpressions
          );
        }

        // Also trigger server maintenance function if available
        if (typeof getSupabaseClient === 'function') {
          const client = getSupabaseClient();
          if (client && client.rpc) {
            await client.rpc('daily_midnight_maintenance').catch(() => {});
          }
        }
      }

      // Reset client daily tallies in storage for the new day
      await chrome.storage.local.set({
        dailyEarnings: 0,
        adsSeenToday: 0,
        lastDailyResetDate: todayUtc
      });

      const state = await getFullState();
      state.dailyEarnings = 0;
      state.adsSeenToday = 0;
      state.lastDailyResetDate = todayUtc;
      updateBadge(state.masterEnabled, state.balanceUsd);
      broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
    } else if (!lastReset) {
      await chrome.storage.local.set({ lastDailyResetDate: todayUtc });
    }
  } catch (e) {
    console.warn('[Surfkit Background] checkAndPerformDailyReset error:', e);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Surfkit Background] Extension installed/updated.');
  await detectAndStoreGeoLocation();
  await syncFromSupabase();
  const state = await getFullState();
  updateBadge(state.masterEnabled, state.balanceUsd);

  chrome.alarms.create('surfkit_heartbeat', { periodInMinutes: 5 });
  scheduleUtcMidnightAlarm();
  await checkAndPerformDailyReset();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncFromSupabase();
  scheduleUtcMidnightAlarm();
  await checkAndPerformDailyReset();
  const state = await getFullState();
  updateBadge(state.masterEnabled, state.balanceUsd);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'surfkit_heartbeat') {
    await syncFromSupabase();
    await checkAndPerformDailyReset();
  } else if (alarm.name === 'surfkit_utc_midnight') {
    await checkAndPerformDailyReset();
    scheduleUtcMidnightAlarm();
  }
});

/**
 * Central Message Router
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message;

  (async () => {
    try {
      const state = await getFullState();
      const currentUser = await SurfkitSupabase.getCurrentUser();

      switch (action) {
        // Return full current state
        case 'GET_STATE': {
          sendResponse({
            success: true,
            data: {
              ...state,
              authUser: currentUser
            }
          });
          break;
        }

        // Live Supabase Authentication
        case 'AUTH_SIGN_IN': {
          const { email, password } = payload || {};
          const result = await SurfkitSupabase.signIn(email, password);
          if (result.success && result.user) {
            state.isExplicitSignOut = false;
            await chrome.storage.local.remove(['isExplicitSignOut']);
            await chrome.storage.local.set({ isExplicitSignOut: false, authUser: result.user, surfkit_auth_user: result.user, supabaseUserId: result.user.id });
            setupRealtimeForUser(result.user.id);
            const freshState = await syncFromSupabase();
            const fullData = { ...(freshState || state), authUser: result.user, isExplicitSignOut: false };
            broadcastToAllTabs({ action: 'STATE_CHANGED', payload: fullData, data: fullData });
            sendResponse({ success: true, user: result.user, data: fullData });
          } else {
            sendResponse(result);
          }
          break;
        }

        case 'AUTH_SET_SESSION': {
          const { user, email } = payload || {};
          let targetUser = user;
          const userEmail = email || (targetUser && targetUser.email);
          const rawId = (targetUser && targetUser.id) || (userEmail ? 'usr_' + userEmail.split('@')[0] : null);
          const realId = await SurfkitSupabase.resolveUuid(rawId, userEmail);
          if (realId) {
            targetUser = { id: realId, email: userEmail, emailName: userEmail ? userEmail.split('@')[0] : 'user' };
          } else if (!targetUser && userEmail) {
            targetUser = { id: rawId, email: userEmail, emailName: userEmail.split('@')[0] };
          }
          if (targetUser && targetUser.id) {
            state.isExplicitSignOut = false;
            await chrome.storage.local.remove(['isExplicitSignOut']);
            await chrome.storage.local.set({ isExplicitSignOut: false, authUser: targetUser, surfkit_auth_user: targetUser, supabaseUserId: targetUser.id });
            await SurfkitSupabase.setSession(targetUser);
            setupRealtimeForUser(targetUser.id);
            const fresh = await syncFromSupabase();
            const fullData = { ...(fresh || state), authUser: targetUser, isExplicitSignOut: false };
            broadcastToAllTabs({ action: 'STATE_CHANGED', payload: fullData, data: fullData });
            sendResponse({ success: true, user: targetUser, data: fullData });
          } else {
            sendResponse({ success: false, error: 'Invalid user payload' });
          }
          break;
        }

        case 'AUTH_SIGN_UP': {
          const { email, password } = payload || {};
          const result = await SurfkitSupabase.signUp(email, password);
          if (result.success && result.user) {
            setupRealtimeForUser(result.user.id);
            await syncFromSupabase();
          }
          sendResponse(result);
          break;
        }

        case 'AUTH_SIGN_OUT': {
          await SurfkitSupabase.signOut();
          if (realtimeChannel) {
            try {
              SurfkitSupabase.unsubscribe(realtimeChannel);
            } catch (e) {}
            realtimeChannel = null;
          }
          activeRealtimeUserId = null;
          const resetState = {
            balanceUsd: 0.000,
            tokensEarned: 0,
            adsSeenToday: 0,
            activeStreakDays: 0,
            stats: { totalImpressions: 0, lifetimeEarnedUsd: 0.000, sessionStartTime: Date.now() },
            authUser: null,
            isExplicitSignOut: true
          };
          await chrome.storage.local.set(resetState);
          updateBadge(state.masterEnabled, 0);
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: resetState, data: resetState });
          sendResponse({ success: true });
          break;
        }

        case 'AUTH_GET_USER': {
          sendResponse({ success: true, user: currentUser });
          break;
        }

        case 'SYNC_WITH_SUPABASE': {
          const fresh = await syncFromSupabase();
          sendResponse({ success: true, data: fresh || state });
          break;
        }

        case 'RECORD_AD_IMPRESSION': {
          if (!currentUser || !currentUser.id) {
            sendResponse({ success: false, error: 'Sign in required to view ads and earn rewards' });
            break;
          }

          const domain = (payload && (payload.website_domain || payload.domain)) || 'web';
          // Geo-Tier based dynamic reward calculation (Tier 1: ~$0.0025, Tier 3: ~$0.0003)
          const rewardUsd = parseFloat(calculateGeoTierReward(state).toFixed(6));
          const slicesEarned = 10; // Standard 10 Surf Creds per ad impression

          let newBal = parseFloat((state.balanceUsd + rewardUsd).toFixed(6));
          let newDaily = parseFloat(((state.dailyEarnings || 0) + rewardUsd).toFixed(6));
          let newDailyImp = (state.adsSeenToday || 0) + 1;
          let newLifetimeImp = ((state.stats && state.stats.totalImpressions) || 0) + 1;
          const streakRes = calculateUpdatedStreak(state.lastActiveDate, state.activeStreakDays);
          let newStreak = streakRes.streak;
          state.lastActiveDate = streakRes.lastActiveDate;

          // Track hourly impression timestamps for strict frequency limit enforcement
          const nowTs = Date.now();
          state.recentImpressionTimestamps = (state.recentImpressionTimestamps || [])
            .filter(ts => (nowTs - ts) < 3600000);
          state.recentImpressionTimestamps.push(nowTs);

          state.balanceUsd = newBal;
          state.dailyEarnings = newDaily;
          state.tokensEarned = (state.tokensEarned || 0) + slicesEarned;
          state.adsSeenToday = newDailyImp;
          state.activeStreakDays = newStreak;
          state.stats = state.stats || {};
          state.stats.totalImpressions = newLifetimeImp;
          state.stats.lifetimeEarnedUsd = parseFloat(((state.stats.lifetimeEarnedUsd || 0) + rewardUsd).toFixed(6));

          await chrome.storage.local.set(state);
          updateBadge(state.masterEnabled, state.balanceUsd);

          // Persist to Supabase atomically
          if (currentUser && currentUser.id) {
            SurfkitSupabase.recordAdImpression(
              currentUser.id,
              domain,
              slicesEarned,
              rewardUsd
            ).catch((err) => console.warn('[Surfkit] recordAdImpression error:', err));
          }

          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });

          sendResponse({
            success: true,
            rewardUsd: rewardUsd,
            tokensAwarded: slicesEarned,
            balanceUsd: state.balanceUsd,
            dailyEarnings: state.dailyEarnings,
            tokensEarned: state.tokensEarned,
            adsSeenToday: state.adsSeenToday,
            activeStreakDays: state.activeStreakDays,
            geoTier: state.geoTier || 3
          });
          break;
        }

        case 'GET_EARNINGS_HISTORY': {
          if (!currentUser || !currentUser.id) {
            sendResponse({ success: false, history: [] });
            break;
          }
          const days = (payload && payload.days) ? payload.days : 30;
          const history = await SurfkitSupabase.getDailyEarningsHistory(currentUser.id, days);
          sendResponse({ success: true, history });
          break;
        }

        // Domain controls
        case 'CHECK_TAB_STATUS': {
          const reqDomain = (payload && payload.domain) ? payload.domain.toLowerCase() : '';
          const isPaused = state.pausedDomains.includes(reqDomain);
          const intensity = state.intensity || 'balanced';

          // Strict hourly frequency by intensity:
          // Low: Exactly 2/hr (30m interval)
          // Balanced: Exactly 4/hr (15m interval)
          // High: Exactly 6/hr (10m interval)
          const hourlyLimits = { low: 2, balanced: 4, high: 6 };
          const minIntervals = { low: 1800000, balanced: 900000, high: 600000 };

          const maxPerHour = hourlyLimits[intensity] || 4;
          const minIntervalMs = minIntervals[intensity] || 900000;

          // Prune timestamps older than 1 rolling hour
          const now = Date.now();
          state.recentImpressionTimestamps = (state.recentImpressionTimestamps || [])
            .filter(ts => (now - ts) < 3600000);

          const countInPastHour = state.recentImpressionTimestamps.length;
          const lastImpressionTs = state.recentImpressionTimestamps.length > 0
            ? Math.max(...state.recentImpressionTimestamps)
            : 0;

          const timeSinceLast = now - lastImpressionTs;
          const underHourlyLimit = countInPastHour < maxPerHour;
          const intervalElapsed = timeSinceLast >= minIntervalMs;

          // Ad is allowed right now only if under hourly cap and interval has elapsed
          const canShowNow = underHourlyLimit && (lastImpressionTs === 0 || intervalElapsed);

          let nextDelayMs = minIntervalMs;
          if (!underHourlyLimit && state.recentImpressionTimestamps.length > 0) {
            const oldestTs = Math.min(...state.recentImpressionTimestamps);
            nextDelayMs = Math.max(5000, 3600000 - (now - oldestTs) + 1000);
          } else if (!intervalElapsed && lastImpressionTs > 0) {
            nextDelayMs = Math.max(5000, minIntervalMs - timeSinceLast);
          }

          sendResponse({
            success: true,
            hasAuthUser: Boolean(currentUser && currentUser.id),
            isOperational: Boolean(currentUser && currentUser.id) && state.masterEnabled && !isPaused,
            masterEnabled: state.masterEnabled,
            isDomainPaused: isPaused,
            intensity: intensity,
            hourlyLimit: maxPerHour,
            intervalMs: minIntervalMs,
            nextDelayMs: nextDelayMs,
            canShowNow: canShowNow,
            geoTier: state.geoTier || 3,
            countryCode: state.countryCode || 'LK'
          });
          break;
        }

        case 'TOGGLE_MASTER': {
          const newStatus = payload && typeof payload.enabled === 'boolean'
            ? payload.enabled
            : !state.masterEnabled;
          state.masterEnabled = newStatus;
          await chrome.storage.local.set({
            masterEnabled: newStatus,
            user_explicit_toggle: newStatus
          });

          // Persist directly to Supabase profiles table
          if (currentUser && currentUser.id) {
            SurfkitSupabase.updateProfileSetting(currentUser.id, {
              auto_surf_enabled: newStatus
            }).catch(() => {});
          }

          updateBadge(newStatus, state.balanceUsd);
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
          sendResponse({ success: true, masterEnabled: newStatus });
          break;
        }

        case 'SET_INTENSITY': {
          const allowed = ['low', 'balanced', 'high'];
          const intensity = payload && allowed.includes(payload.intensity) ? payload.intensity : 'balanced';
          state.intensity = intensity;
          await chrome.storage.local.set({ intensity });

          // Persist directly to Supabase profiles table
          if (currentUser && currentUser.id) {
            SurfkitSupabase.updateProfileSetting(currentUser.id, {
              ad_intensity: intensity
            }).catch(() => {});
          }

          const newHourlyInterval = { low: 1800000, balanced: 900000, high: 600000 }[intensity] || 900000;
          broadcastToAllTabs({ action: 'INTENSITY_CHANGED', payload: { intensity, interval: newHourlyInterval, hourlyLimit: { low: 2, balanced: 4, high: 6 }[intensity] } });
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
          sendResponse({ success: true, intensity });
          break;
        }

        case 'TOGGLE_DOMAIN_PAUSE': {
          const domain = payload && payload.domain ? payload.domain.toLowerCase() : '';
          if (!domain) {
            sendResponse({ success: false, error: 'Invalid domain' });
            return;
          }
          const index = state.pausedDomains.indexOf(domain);
          let isPaused = false;
          if (index > -1) {
            state.pausedDomains.splice(index, 1);
            isPaused = false;
          } else {
            state.pausedDomains.push(domain);
            isPaused = true;
          }
          await chrome.storage.local.set({ pausedDomains: state.pausedDomains });
          broadcastToAllTabs({ action: 'DOMAIN_STATUS_CHANGED', payload: { domain, isPaused } });
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
          sendResponse({ success: true, domain, isPaused, pausedDomains: state.pausedDomains });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action: ' + action });
      }
    } catch (err) {
      console.error('[Surfkit Background] Message error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});

/**
 * Handle external web dashboard messages (file://, localhost)
 * Mirrors the full internal message router so the web dashboard
 * can call all the same actions as the popup.
 */
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const state = await getFullState();
      const currentUser = await SurfkitSupabase.getCurrentUser();
      const { action, payload } = message;

      // Handle authentication requests from external dashboard (Bidirectional SSO)
      if (action === 'AUTH_SET_SESSION') {
        const { user, email } = payload || {};
        let targetUser = user;
        const userEmail = email || (targetUser && targetUser.email);
        const rawId = (targetUser && targetUser.id) || (userEmail ? 'usr_' + userEmail.split('@')[0] : null);
        const realId = await SurfkitSupabase.resolveUuid(rawId, userEmail);
        if (realId) {
          targetUser = { id: realId, email: userEmail, emailName: userEmail ? userEmail.split('@')[0] : 'user' };
        } else if (!targetUser && userEmail) {
          targetUser = { id: rawId, email: userEmail, emailName: userEmail.split('@')[0] };
        }
        if (targetUser && targetUser.id) {
          state.isExplicitSignOut = false;
          await chrome.storage.local.remove(['isExplicitSignOut']);
          await chrome.storage.local.set({ isExplicitSignOut: false, authUser: targetUser, surfkit_auth_user: targetUser, supabaseUserId: targetUser.id });
          await SurfkitSupabase.setSession(targetUser);
          setupRealtimeForUser(targetUser.id);
          const fresh = await syncFromSupabase();
          const fullData = { ...(fresh || state), authUser: targetUser, isExplicitSignOut: false };
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: fullData, data: fullData });
          sendResponse({ success: true, user: targetUser, data: fullData });
        } else {
          sendResponse({ success: false, error: 'Invalid user payload' });
        }
        return;
      }
      if (action === 'AUTH_SIGN_IN') {
        const { email, password } = payload || {};
        const result = await SurfkitSupabase.signIn(email, password);
        if (result.success && result.user) {
          state.isExplicitSignOut = false;
          await chrome.storage.local.remove(['isExplicitSignOut']);
          await chrome.storage.local.set({ isExplicitSignOut: false, authUser: result.user, surfkit_auth_user: result.user, supabaseUserId: result.user.id });
          setupRealtimeForUser(result.user.id);
          const freshState = await syncFromSupabase();
          const fullData = { ...(freshState || state), authUser: result.user, isExplicitSignOut: false };
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: fullData, data: fullData });
          sendResponse({ success: true, user: result.user, data: fullData });
        } else {
          sendResponse(result);
        }
        return;
      }
      if (action === 'AUTH_SIGN_OUT') {
        await SurfkitSupabase.signOut();
        if (realtimeChannel) {
          try {
            const client = getSupabaseClient();
            if (client) client.removeChannel(realtimeChannel);
          } catch (e) {}
          realtimeChannel = null;
        }
        const resetState = {
          balanceUsd: 0.000,
          tokensEarned: 0,
          adsSeenToday: 0,
          activeStreakDays: 0,
          stats: { totalImpressions: 0, lifetimeEarnedUsd: 0.000, sessionStartTime: Date.now() },
          authUser: null,
          isExplicitSignOut: true
        };
        await chrome.storage.local.set(resetState);
        updateBadge(state.masterEnabled, 0);
        broadcastToAllTabs({ action: 'STATE_CHANGED', payload: resetState, data: resetState });
        sendResponse({ success: true });
        return;
      }
      if (action === 'AUTH_GET_USER') {
        sendResponse({ success: true, user: currentUser });
        return;
      }

      switch (action) {
        case 'GET_STATE': {
          sendResponse({ success: true, data: { ...state, authUser: currentUser } });
          break;
        }
        case 'RECORD_AD_IMPRESSION': {
          if (!currentUser || !currentUser.id) {
            sendResponse({ success: false, error: 'Sign in required to view ads and earn rewards' });
            break;
          }

          const domain = (payload && (payload.domain || payload.website_domain)) || 'web-dashboard';
          const rewardUsd = parseFloat(calculateGeoTierReward(state).toFixed(6));
          const slicesEarned = 10;

          state.balanceUsd = parseFloat((state.balanceUsd + rewardUsd).toFixed(6));
          state.dailyEarnings = parseFloat(((state.dailyEarnings || 0) + rewardUsd).toFixed(6));
          state.tokensEarned = (state.tokensEarned || 0) + slicesEarned;
          state.adsSeenToday = (state.adsSeenToday || 0) + 1;
          const extStreakRes = calculateUpdatedStreak(state.lastActiveDate, state.activeStreakDays);
          state.activeStreakDays = extStreakRes.streak;
          state.lastActiveDate = extStreakRes.lastActiveDate;
          state.stats = state.stats || {};
          state.stats.totalImpressions = (state.stats.totalImpressions || 0) + 1;
          state.stats.lifetimeEarnedUsd = parseFloat(((state.stats.lifetimeEarnedUsd || 0) + rewardUsd).toFixed(6));

          const nowExt = Date.now();
          state.recentImpressionTimestamps = (state.recentImpressionTimestamps || []).filter(ts => (nowExt - ts) < 3600000);
          state.recentImpressionTimestamps.push(nowExt);

          await chrome.storage.local.set(state);
          updateBadge(state.masterEnabled, state.balanceUsd);

          if (currentUser && currentUser.id) {
            SurfkitSupabase.recordAdImpression(currentUser.id, domain, slicesEarned, rewardUsd).catch((err) => {
              console.warn('[Surfkit External] recordAdImpression error:', err);
            });
          }

          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
          sendResponse({ success: true, balanceUsd: state.balanceUsd, dailyEarnings: state.dailyEarnings, tokensEarned: state.tokensEarned, adsSeenToday: state.adsSeenToday });
          break;
        }
        case 'TOGGLE_MASTER': {
          const newStatus = payload && typeof payload.enabled === 'boolean' ? payload.enabled : !state.masterEnabled;
          state.masterEnabled = newStatus;
          await chrome.storage.local.set({ masterEnabled: newStatus, user_explicit_toggle: newStatus });
          if (currentUser && currentUser.id) {
            SurfkitSupabase.updateProfileSetting(currentUser.id, { auto_surf_enabled: newStatus }).catch(() => {});
          }
          updateBadge(newStatus, state.balanceUsd);
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
          sendResponse({ success: true, masterEnabled: newStatus });
          break;
        }
        case 'SET_INTENSITY': {
          const allowed = ['low', 'balanced', 'high'];
          const intensity = payload && allowed.includes(payload.intensity) ? payload.intensity : 'balanced';
          state.intensity = intensity;
          await chrome.storage.local.set({ intensity });
          if (currentUser && currentUser.id) {
            SurfkitSupabase.updateProfileSetting(currentUser.id, { ad_intensity: intensity }).catch(() => {});
          }
          const newHourlyInterval = { low: 1800000, balanced: 900000, high: 600000 }[intensity] || 900000;
          broadcastToAllTabs({ action: 'INTENSITY_CHANGED', payload: { intensity, interval: newHourlyInterval, hourlyLimit: { low: 2, balanced: 4, high: 6 }[intensity] } });
          broadcastToAllTabs({ action: 'STATE_CHANGED', payload: state, data: state });
          sendResponse({ success: true, intensity });
          break;
        }
        case 'SYNC_WITH_SUPABASE': {
          const fresh = await syncFromSupabase();
          sendResponse({ success: true, data: fresh || state });
          break;
        }
        default: {
          sendResponse({ success: true, data: { ...state, authUser: currentUser } });
        }
      }
    } catch (e) {
      console.error('[Surfkit Background] External message error:', e);
      sendResponse({ success: false, error: e.message });
    }
  })();
  return true;
});
