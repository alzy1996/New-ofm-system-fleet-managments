/* ============================================================
   ERP NEXUS — CORE  (shared auth · multi-site · permissions)
   Loaded by every module + login.html via <script src>.
   Owns the SINGLE Firebase config, the session model,
   site-scoped data loading, and permission-aware chrome.
   Requires firebase-app-compat + firebase-firestore-compat
   to be loaded BEFORE this file.
   ============================================================ */
(function (global) {
  "use strict";

  /* ---- New Firebase project (procurement-erp) ---- */
  var firebaseConfig = {
    apiKey: "AIzaSyD_c66g5arReA_ePgXjg-3Z387q9IbNUcY",
    authDomain: "procurement-erp-6e271.firebaseapp.com",
    projectId: "procurement-erp-6e271",
    storageBucket: "procurement-erp-6e271.firebasestorage.app",
    messagingSenderId: "726316664067",
    appId: "1:726316664067:web:9cfabcbd75487886991536",
    measurementId: "G-ESMR0D8RKK"
  };

  var db = null;
  try {
    if (global.firebase && !firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(function () {});
  } catch (e) { console.warn("[nexus-core] firebase init", e); }
  global.db = db;

  var SESSION_KEY = "nexus_session";
  var ALL = "__ALL__"; /* admin aggregate "all sites" */

  /* All gateable sections (nav id -> label). Mirrors the NAV array ids. */
  var SECTIONS = [
    { id: "dashboard", label: "Command Center" },
    { id: "analytics", label: "Analytics" },
    { id: "materials", label: "Materials" },
    { id: "suppliers", label: "Suppliers" },
    { id: "offers", label: "Offers" },
    { id: "purchaserequests", label: "Purchase Requests" },
    { id: "notifications", label: "Notifications" },
    { id: "settings", label: "Settings" }
  ];

  var _session = undefined; /* memo */
  var _sitesCache = null;   /* [{id,name,...}] */

  /* ---------- session ---------- */

  /**
   * Read the current session from localStorage (memoised).
   * @returns {object|null} session or null when not logged in.
   */
  function session() {
    if (_session !== undefined) { return _session; }
    try { _session = JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
    catch (e) { _session = null; }
    return _session;
  }

  /**
   * Persist a session object and refresh the memo.
   * @param {object} s - session to store.
   */
  function setSession(s) {
    _session = s;
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  /** Clear the session and return to the login page. */
  function logout() {
    localStorage.removeItem(SESSION_KEY);
    _session = undefined;
    location.replace("login.html");
  }

  /**
   * Guard a module: redirect to login when unauthenticated.
   * @returns {boolean} true when a valid session exists.
   */
  function requireAuth() {
    if (!session()) { location.replace("login.html"); return false; }
    return true;
  }

  /** @returns {boolean} whether the current user has god-mode. */
  function isAdmin() {
    var s = session();
    return !!(s && s.isAdmin);
  }

  /**
   * Whether the current user may see a given section/nav id.
   * @param {string} navId - section id (e.g. "materials").
   * @returns {boolean}
   */
  function canSee(navId) {
    if (!navId) { return true; }
    if (isAdmin()) { return true; }
    var s = session();
    return !!(s && s.sections && s.sections[navId] === true);
  }

  /** @returns {string} the active site id ("__ALL__" for admin aggregate). */
  function activeSite() {
    var s = session();
    if (!s) { return null; }
    return s.activeSite || ALL;
  }

  /**
   * Switch the active site and reload so data re-scopes.
   * @param {string} id - site id or "__ALL__".
   */
  function switchSite(id) {
    var s = session();
    if (!s) { return; }
    s.activeSite = id;
    setSession(s);
    location.reload();
  }

  /* ---------- password hashing ---------- */

  /**
   * SHA-256 hash a password to a hex string (no plaintext is ever stored).
   * @param {string} pw - plaintext password.
   * @returns {Promise<string>} hex digest.
   */
  function hash(pw) {
    var enc = new TextEncoder().encode(String(pw));
    return crypto.subtle.digest("SHA-256", enc).then(function (buf) {
      var bytes = new Uint8Array(buf);
      var hex = "";
      for (var i = 0; i < bytes.length; i++) { hex += bytes[i].toString(16).padStart(2, "0"); }
      return hex;
    });
  }

  /* ---------- auth flows ---------- */

  /**
   * Attempt a username/password login against nexus_users.
   * @param {string} username
   * @param {string} password
   * @returns {Promise<object>} resolves with session, rejects with Error(message).
   */
  function login(username, password) {
    username = String(username || "").trim().toLowerCase();
    if (!db) { return Promise.reject(new Error("Offline — cannot reach the database")); }
    if (!username || !password) { return Promise.reject(new Error("Enter username and password")); }
    return hash(password).then(function (ph) {
      return db.collection("nexus_users").where("username", "==", username).limit(1).get().then(function (snap) {
        if (snap.empty) { throw new Error("Unknown username or password"); }
        var doc = snap.docs[0];
        var u = doc.data();
        if (u.passwordHash !== ph) { throw new Error("Unknown username or password"); }
        if (u.status && u.status !== "Active") { throw new Error("Account is " + u.status + " — contact your administrator"); }
        var sites = u.sites || [];
        var s = {
          uid: doc.id,
          username: u.username,
          name: u.name || u.username,
          jobType: u.jobType || "User",
          isAdmin: !!u.isAdmin,
          sites: sites,
          sections: u.sections || {},
          activeSite: u.isAdmin ? ALL : (sites[0] || null)
        };
        setSession(s);
        return s;
      });
    });
  }

  /**
   * Whether any user exists yet (controls first-admin bootstrap).
   * @returns {Promise<boolean>}
   */
  function hasAnyUser() {
    if (!db) { return Promise.resolve(true); }
    return db.collection("nexus_users").limit(1).get()
      .then(function (s) { return !s.empty; })
      .catch(function () { return true; });
  }

  /**
   * Create the first administrator (god-mode, all sections).
   * @param {string} name
   * @param {string} username
   * @param {string} password
   * @returns {Promise<object>} the created session.
   */
  function bootstrapAdmin(name, username, password) {
    username = String(username || "").trim().toLowerCase();
    if (!name || !username || !password) { return Promise.reject(new Error("All fields are required")); }
    var sections = {};
    SECTIONS.forEach(function (x) { sections[x.id] = true; });
    return hash(password).then(function (ph) {
      return db.collection("nexus_users").add({
        username: username, passwordHash: ph, name: name,
        jobType: "Administrator", isAdmin: true, sites: [], sections: sections,
        status: "Active", createdAt: Date.now()
      });
    }).then(function (ref) {
      var s = {
        uid: ref.id, username: username, name: name, jobType: "Administrator",
        isAdmin: true, sites: [], sections: sections, activeSite: ALL
      };
      setSession(s);
      return s;
    });
  }

  /* ---------- site list ---------- */

  /**
   * Load sites visible to the current user (all for admin, assigned otherwise).
   * @returns {Promise<Array>} array of {id, name, ...}.
   */
  function sites() {
    if (_sitesCache) { return Promise.resolve(_sitesCache); }
    if (!db) { return Promise.resolve([]); }
    return db.collection("nexus_sites").get().then(function (snap) {
      var all = snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
      var s = session();
      if (s && !s.isAdmin) { all = all.filter(function (x) { return (s.sites || []).indexOf(x.id) > -1; }); }
      _sitesCache = all;
      return all;
    }).catch(function () { return []; });
  }

  /* ---------- scoped data ---------- */

  /**
   * Fetch one collection scoped to the active site.
   * Admin viewing "__ALL__" gets every document.
   * @param {string} shortName - collection name without the "nexus_" prefix.
   * @returns {Promise<Array>} documents (each with .id).
   */
  function fetchScoped(shortName) {
    if (!db) { return Promise.resolve([]); }
    var col = db.collection("nexus_" + shortName);
    var s = session();
    var q = col;
    if (!(s && s.isAdmin && s.activeSite === ALL)) {
      q = col.where("siteId", "==", activeSite());
    }
    return q.get().then(function (snap) {
      return snap.docs.map(function (d) { var o = d.data(); o.id = d.id; return o; });
    }).catch(function (e) { console.warn("[nexus-core] fetch " + shortName, e); return []; });
  }

  /**
   * Load several scoped collections, then apply each into the module's
   * existing data arrays. Empty collections are skipped so demo SEED
   * fallback data still renders on a fresh project.
   * @param {Array<{name:string, apply:function(Array):void}>} specs
   * @returns {Promise<void>}
   */
  function load(specs) {
    var jobs = (specs || []).map(function (spec) {
      return fetchScoped(spec.name).then(function (rows) {
        if (rows && rows.length) { spec.apply(rows); }
      });
    });
    return Promise.all(jobs).then(function () {});
  }

  /* ---------- scoped writes ---------- */

  /**
   * Add a document, auto-stamped with siteId / author / timestamp.
   * @param {string} shortName - collection without "nexus_" prefix.
   * @param {object} data
   * @returns {Promise} Firestore add() promise.
   */
  function add(shortName, data) {
    if (!db) { return Promise.reject(new Error("offline")); }
    var s = session();
    var site = activeSite();
    if (site === ALL) { site = (s && s.sites && s.sites[0]) || null; }
    var doc = Object.assign({}, data, {
      siteId: data.siteId || site,
      createdBy: (s && s.username) || "system",
      createdAt: Date.now()
    });
    return db.collection("nexus_" + shortName).add(doc);
  }

  /**
   * Merge-set a document by id, auto-stamped with siteId + timestamp.
   * @param {string} shortName
   * @param {string} id
   * @param {object} data
   * @returns {Promise}
   */
  function set(shortName, id, data) {
    if (!db) { return Promise.reject(new Error("offline")); }
    var site = activeSite();
    if (site === ALL) { site = null; }
    var doc = Object.assign({}, data, { updatedAt: Date.now() });
    if (site && !doc.siteId) { doc.siteId = site; }
    return db.collection("nexus_" + shortName).doc(id).set(doc, { merge: true });
  }

  /* ---------- chrome: identity, nav filtering, site switcher ---------- */

  /**
   * Stamp the logged-in identity into the module's global data objects so the
   * existing sidebar footer renders the real user (no per-module edit needed).
   */
  function applyIdentity() {
    var s = session();
    if (!s) { return; }
    var initials = s.name.split(" ").map(function (w) { return w[0] || ""; }).slice(0, 2).join("").toUpperCase();
    var ident = { name: s.name, role: s.jobType, initials: initials };
    if (global.SEED && global.SEED.user) { global.SEED.user = ident; }
    if (global.USER) { global.USER = Object.assign({}, global.USER, ident); }
  }

  /**
   * Redirect away from a section the user is not permitted to see.
   * @param {string} current - the module's CURRENT nav id.
   * @returns {boolean} false when a redirect was triggered.
   */
  function guardSection(current) {
    if (canSee(current)) { return true; }
    var first = SECTIONS.filter(function (x) { return canSee(x.id); })[0];
    if (first) { location.replace(first.id + ".html"); }
    else { logout(); }
    return false;
  }

  /** Remove sidebar + bottom-nav links the user may not access. */
  function filterNav() {
    var links = document.querySelectorAll(".nav-i, .bn-i");
    links.forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var id = href.replace(".html", "");
      if (id && !canSee(id)) { a.remove(); }
    });
  }

  /** Inject the active-site switcher into the topbar actions area. */
  function injectSiteSwitcher() {
    var host = document.querySelector(".tb-actions");
    if (!host || document.getElementById("nexusSiteSwitch")) { return; }
    var wrap = document.createElement("div");
    wrap.id = "nexusSiteSwitch";
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;background:var(--surface-2,#FAFBFE);border:1px solid var(--border,#E7EAF2);border-radius:20px;padding:4px 6px 4px 11px;font-size:11.5px;font-weight:700;color:var(--text,#0F1117);";
    wrap.innerHTML = '<span aria-hidden="true">📍</span>';
    var sel = document.createElement("select");
    sel.setAttribute("aria-label", "Active site");
    sel.style.cssText = "border:none;background:transparent;font:inherit;color:inherit;font-weight:700;outline:none;cursor:pointer;max-width:150px;";
    wrap.appendChild(sel);
    host.insertBefore(wrap, host.firstChild);

    sites().then(function (list) {
      var s = session();
      var html = "";
      if (s && s.isAdmin) { html += '<option value="' + ALL + '">All sites (God mode)</option>'; }
      list.forEach(function (x) {
        var seld = x.id === activeSite() ? " selected" : "";
        html += '<option value="' + x.id + '"' + seld + ">" + escapeHtml(x.name) + "</option>";
      });
      if (!list.length && !(s && s.isAdmin)) { html = '<option>No site assigned</option>'; }
      sel.innerHTML = html;
      if (list.length <= 1 && !(s && s.isAdmin)) { sel.disabled = true; sel.style.cursor = "default"; }
    });
    sel.addEventListener("change", function () { switchSite(sel.value); });
  }

  /** Minimal HTML escape for option labels. @param {string} t @returns {string} */
  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var _observing = false;

  /**
   * One-call chrome setup for a module: filter the nav, inject the site
   * switcher, and keep the nav filtered across later shell re-renders.
   * Safe to call after renderShell().
   * @param {string} current - module CURRENT nav id.
   */
  function applyChrome(current) {
    filterNav();
    injectSiteSwitcher();
    if (!_observing) {
      _observing = true;
      var sb = document.getElementById("sidebar");
      var bn = document.getElementById("bottomNav");
      var obs = new MutationObserver(function () { filterNav(); });
      if (sb) { obs.observe(sb, { childList: true, subtree: true }); }
      if (bn) { obs.observe(bn, { childList: true, subtree: true }); }
    }
    void current;
  }

  /* ---------- exports ---------- */
  global.Nexus = {
    ALL: ALL,
    SECTIONS: SECTIONS,
    db: db,
    session: session,
    setSession: setSession,
    requireAuth: requireAuth,
    isAdmin: isAdmin,
    canSee: canSee,
    activeSite: activeSite,
    switchSite: switchSite,
    sites: sites,
    hash: hash,
    login: login,
    logout: logout,
    hasAnyUser: hasAnyUser,
    bootstrapAdmin: bootstrapAdmin,
    fetchScoped: fetchScoped,
    load: load,
    add: add,
    set: set,
    applyIdentity: applyIdentity,
    guardSection: guardSection,
    applyChrome: applyChrome
  };
})(window);
