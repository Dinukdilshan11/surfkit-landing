/**
 * Surfkit Auth Session Manager  v1.0
 * ===================================
 * Shared session-detection utility for Landing Pages.
 * Checks: Supabase JWT localStorage → Extension sync flag → postMessage events.
 * No external CDN dependency – runs synchronously where possible.
 *
 * Usage: included via  <script src="auth-session.js"></script>
 * Exposes: window.SurfkitAuth  (see bottom of file)
 */
(function (global) {
  'use strict';

  /* ── Constants ───────────────────────────────────────────────── */
  var SUPA_REF  = 'kpvrewhmnrifsnkgswdt';
  var SUPA_URL  = 'https://' + SUPA_REF + '.supabase.co';
  var SUPA_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtwdnJld2htbnJpZnNua2dzd2R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4Mjc4OTQsImV4cCI6MjEwODQwMzg5NH0.HQLPHVNkZ83wQC8dqHINlZ4F7qKR7lML3XQv7tAxX9w';
  var LS_JWT    = 'sb-' + SUPA_REF + '-auth-token';  // Supabase v2 JWT key
  var LS_EXT    = 'surfkit_ext_auth_user';            // Extension writes this on sign-in
  var LS_DASH   = 'surfkit_dashboard_state_v1';       // Dashboard state cache (secondary)

  /* ── Helpers ──────────────────────────────────────────────────── */
  function isValidEmail(e) {
    if (!e || typeof e !== 'string') return false;
    var c = e.trim().toLowerCase();
    if (c === 'guest@surfkit.cloud' || c === 'guest' || c === 'null') return false;
    return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(c);
  }

  /* ── 1. Fast synchronous: Supabase JWT in localStorage ───────── */
  function checkSupabaseLS() {
    try {
      var raw = localStorage.getItem(LS_JWT);
      if (!raw) return null;
      var p = JSON.parse(raw);
      /* Supabase v2 stores flat or nested under currentSession */
      var user    = p.user || (p.currentSession && p.currentSession.user);
      var token   = p.access_token || (p.currentSession && p.currentSession.access_token);
      var expAt   = p.expires_at   || (p.currentSession && p.currentSession.expires_at);
      if (!token || !user || !isValidEmail(user.email)) return null;
      if (expAt && Math.floor(Date.now() / 1000) >= Number(expAt)) return null;
      return {
        id:    user.id || '',
        email: user.email.trim().toLowerCase(),
        name:  (user.user_metadata && user.user_metadata.display_name)
                 || user.email.split('@')[0]
      };
    } catch (e) { return null; }
  }

  /* ── 2. Fast synchronous: Extension localStorage flag ────────── */
  function checkExtLS() {
    try {
      /* Primary: extension explicitly writes this key on user sign-in */
      var raw = localStorage.getItem(LS_EXT);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && isValidEmail(d.email) && d.timestamp) {
          if ((Date.now() - d.timestamp) < 3600000) {        // 1-hour TTL
            return { email: d.email.trim().toLowerCase(), name: d.name || d.email.split('@')[0] };
          }
        }
      }
      /* Secondary: dashboard state cache */
      var stRaw = localStorage.getItem(LS_DASH);
      if (stRaw) {
        var st = JSON.parse(stRaw);
        if (st && st.user && isValidEmail(st.user.email) && st.user.name !== 'Guest User') {
          return { email: st.user.email.trim().toLowerCase(), name: st.user.name };
        }
      }
    } catch (e) {}
    return null;
  }

  /* ── 3. Async: Supabase network check (uses CDN client if loaded) */
  async function checkSupabaseNetwork() {
    try {
      if (global.supabase && typeof global.supabase.createClient === 'function') {
        var client = global.supabase.createClient(SUPA_URL, SUPA_KEY);
        var res = await client.auth.getSession();
        if (res.data && res.data.session && res.data.session.user) {
          var u = res.data.session.user;
          return {
            id:    u.id || '',
            email: u.email.trim().toLowerCase(),
            name:  (u.user_metadata && u.user_metadata.display_name) || u.email.split('@')[0]
          };
        }
      }
    } catch (e) {}
    return null;
  }

  /* ── Public: full async check ─────────────────────────────────── */
  async function getActiveSession() {
    var local = checkSupabaseLS();
    if (local) return local;
    var ext = checkExtLS();
    if (ext) return ext;
    return await checkSupabaseNetwork();
  }

  /* ── Public: write extension session flag ────────────────────── */
  function setExtensionSession(email, name) {
    if (!isValidEmail(email)) return;
    try {
      localStorage.setItem(LS_EXT, JSON.stringify({
        email: email.trim().toLowerCase(),
        name:  name || email.split('@')[0],
        timestamp: Date.now()
      }));
    } catch (e) {}
  }

  /* ── Public: clear extension session flag ───────────────────── */
  function clearExtensionSession() {
    try { localStorage.removeItem(LS_EXT); } catch (e) {}
  }

  /* ── Expose ───────────────────────────────────────────────────── */
  global.SurfkitAuth = {
    getActiveSession:      getActiveSession,
    checkSupabaseLS:       checkSupabaseLS,
    checkExtLS:            checkExtLS,
    setExtensionSession:   setExtensionSession,
    clearExtensionSession: clearExtensionSession,
    SUPA_URL: SUPA_URL,
    SUPA_KEY: SUPA_KEY
  };

})(window);
