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

  var auth = null, storage = null;
  try {
    auth = firebase.auth(); storage = firebase.storage();
    global.authReady = auth.signInAnonymously().catch(function (e) { console.warn("[nexus-core] auth", e); });
  } catch (e) { console.warn("[nexus-core] auth/storage init", e); }
  global.auth = auth; global.storage = storage;

  /* ---- secure file upload (whitelist + magic bytes + UUID + Cloud Storage) ---- */
  var CLD_NAME = "dxYOURNAME";
  var CLD_PRESET = "nexus_unsigned";
  var ALLOW = { jpg: [[0xFF, 0xD8, 0xFF]], jpeg: [[0xFF, 0xD8, 0xFF]], png: [[0x89, 0x50, 0x4E, 0x47]], pdf: [[0x25, 0x50, 0x44, 0x46]] };
  var BLOCK = /\.(php|phtml|php5|pht|phar|jsp|asp|aspx|py|sh|exe|bat|cmd|js|html?)$/i;
  var MAXB = 5 * 1024 * 1024;
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now() + "" + Math.random().toString(36).slice(2); }
  function magicOK(b, sigs) { return sigs.some(function (s) { return s.every(function (x, i) { return b[i] === x; }); }); }

  /**
   * Cloudinary unsigned upload. @param {Blob} blob @param {string} folder
   * @returns {Promise<{url:string,path:string}>} resolves with secure_url.
   */
  function cloudinaryUpload(blob, folder) {
    var fd = new FormData();
    fd.append("file", blob);
    fd.append("upload_preset", CLD_PRESET);
    if (folder) { fd.append("folder", folder); }
    fd.append("public_id", uuid());
    return fetch("https://api.cloudinary.com/v1_1/" + CLD_NAME + "/auto/upload", { method: "POST", body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.secure_url) { throw new Error((j && j.error && j.error.message) || "Upload failed"); }
        return { url: j.secure_url, path: j.public_id };
      });
  }

  /**
   * Validate (ext + magic bytes + size, block executables) then upload to
   * Cloudinary. @param {File} file @param {string} folder
   * @returns {Promise<{url:string,path:string}>}
   */
  function uploadFile(file, folder) {
    return new Promise(function (res, rej) {
      if (!file) { return rej(new Error("No file")); }
      if (file.size > MAXB) { return rej(new Error("Max 5MB")); }
      var nm = (file.name || "").toLowerCase(), ext = nm.split(".").pop();
      if (BLOCK.test(nm) || !ALLOW[ext]) { return rej(new Error("Only jpg, png, pdf")); }
      var fr = new FileReader();
      fr.onload = function () {
        if (!magicOK(new Uint8Array(fr.result), ALLOW[ext])) { return rej(new Error("Content does not match extension")); }
        cloudinaryUpload(file, folder).then(res).catch(rej);
      };
      fr.onerror = function () { rej(new Error("Read failed")); };
      fr.readAsArrayBuffer(file.slice(0, 8));
    });
  }

  /** Upload a generated blob (e.g. signature PNG) to Cloudinary — trusted, no magic check. */
  function uploadBlob(blob, folder, ext) { void ext; return cloudinaryUpload(blob, folder); }

  /** Save FIRST, then open WhatsApp after 500ms. */
  function sendWhatsApp(number, msg, saveFn) {
    var url = "https://wa.me/" + String(number).replace(/\D/g, "") + "?text=" + encodeURIComponent(msg);
    return Promise.resolve(saveFn && saveFn()).then(function () { setTimeout(function () { window.open(url, "_blank", "noopener,noreferrer"); }, 500); });
  }
  /** Save FIRST, then open mailto after 500ms. */
  function sendEmail(email, subject, body, saveFn) {
    var url = "mailto:" + email + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    return Promise.resolve(saveFn && saveFn()).then(function () { setTimeout(function () { window.open(url, "_blank", "noopener,noreferrer"); }, 500); });
  }

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
    { id: "contracts", label: "Contracts" },
    { id: "attendance", label: "Attendance" },
    { id: "notifications", label: "Notifications" },
    { id: "settings", label: "Settings" }
  ];

  /* New modules to inject into every module's nav (id, label, icon, section header). */
  var NAV_EXTRA = [
    { id: "contracts", label: "Contracts", ico: "📄", after: "purchaserequests" },
    { id: "attendance", label: "Attendance", ico: "🛂", after: "contracts" }
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
   * Resolve a concrete site id to WRITE new records under.
   * Uses the active site when one is selected; otherwise (admin "All sites")
   * falls back to the only site that exists / is assigned. Returns null only
   * when the choice is genuinely ambiguous (admin with several sites) or no
   * site exists yet — callers should then ask the user to pick / create one.
   * @returns {string|null}
   */
  function resolveSite() {
    var a = activeSite();
    if (a && a !== ALL) { return a; }
    if (_sitesCache && _sitesCache.length === 1) { return _sitesCache[0].id; }
    var s = session();
    if (s && s.sites && s.sites.length === 1) { return s.sites[0]; }
    return null;
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
   * existing data arrays. Always applies the fetched result (including an
   * empty array) so deletions and an emptied collection are reflected in the
   * UI — otherwise a just-deleted last item would linger on screen.
   * @param {Array<{name:string, apply:function(Array):void}>} specs
   * @returns {Promise<void>}
   */
  function load(specs) {
    var jobs = (specs || []).map(function (spec) {
      return fetchScoped(spec.name).then(function (rows) {
        spec.apply(rows || []);
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
    var site = resolveSite();
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

  /* ---------- deletes (admin only) ---------- */

  /**
   * Delete a single document by id. Restricted to administrators.
   * @param {string} shortName - collection without "nexus_" prefix.
   * @param {string} id
   * @returns {Promise}
   */
  function remove(shortName, id) {
    if (!isAdmin()) { return Promise.reject(new Error("Only administrators can delete data")); }
    if (!db || !id) { return Promise.reject(new Error("offline")); }
    return db.collection("nexus_" + shortName).doc(id).delete();
  }

  /**
   * Bulk-delete every document in a collection. Restricted to administrators.
   * Scoped to the active site unless the admin is viewing "All sites".
   * @param {string} shortName - collection without "nexus_" prefix.
   * @returns {Promise<number>} number of documents deleted.
   */
  function wipe(shortName) {
    if (!isAdmin()) { return Promise.reject(new Error("Only administrators can delete data")); }
    if (!db) { return Promise.reject(new Error("offline")); }
    var col = db.collection("nexus_" + shortName);
    var q = col;
    if (activeSite() !== ALL) { q = col.where("siteId", "==", activeSite()); }
    return q.get().then(function (snap) {
      if (snap.empty) { return 0; }
      var batch = db.batch();
      snap.docs.forEach(function (d) { batch.delete(d.ref); });
      return batch.commit().then(function () { return snap.size; });
    });
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

  /**
   * Inject the new-module links (Contracts, Attendance) into the sidebar of any
   * module whose NAV array predates them — so navigation is consistent app-wide
   * without editing each module. Idempotent + permission-aware.
   */
  function ensureNavItems() {
    var nav = document.querySelector("#sidebar .sb-nav");
    if (!nav) { return; }
    NAV_EXTRA.forEach(function (item) {
      if (!canSee(item.id)) { return; }
      if (nav.querySelector('a[href="' + item.id + '.html"]')) { return; }
      var anchor = nav.querySelector('a[href="' + item.after + '.html"]');
      var a = document.createElement("a");
      a.className = "nav-i";
      a.href = item.id + ".html";
      if ((global.CURRENT || "") === item.id) { a.className += " active"; }
      a.innerHTML = '<span class="nav-ico">' + item.ico + "</span>" + tr(item.label);
      if (anchor && anchor.parentNode) { anchor.parentNode.insertBefore(a, anchor.nextSibling); }
      else { nav.appendChild(a); }
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

  /* ---------- geo + image helpers ---------- */

  /**
   * Great-circle distance between two lat/lng points (Haversine), in METRES.
   * @param {number} la1 @param {number} lo1 @param {number} la2 @param {number} lo2
   * @returns {number} distance in metres.
   */
  function haversine(la1, lo1, la2, lo2) {
    var R = 6371000;
    var r = function (d) { return d * Math.PI / 180; };
    var dLa = r(la2 - la1), dLo = r(lo2 - lo1);
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * Read an image File, downscale to maxPx on the longest edge, and return a
   * compressed JPEG data URL (keeps Firestore docs well under 1 MB).
   * @param {File} file @param {number} maxPx @param {number} quality 0..1
   * @returns {Promise<string>} data URL.
   */
  function resizeImage(file, maxPx, quality) {
    maxPx = maxPx || 1000; quality = quality || 0.6;
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error("no file")); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var w = img.width, h = img.height;
          var scale = Math.min(1, maxPx / Math.max(w, h));
          var cv = document.createElement("canvas");
          cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
          cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL("image/jpeg", quality));
        };
        img.onerror = function () { reject(new Error("bad image")); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error("read failed")); };
      reader.readAsDataURL(file);
    });
  }

  /* ---------- i18n + RTL (whole app, lives in the shared core) ---------- */

  var LANG_KEY = "nexus-lang";
  /* Exact-string EN→AR dictionary. Only whole-string matches are swapped, so
     numbers, names, plates and dynamic data are never corrupted. */
  var DICT = {
    /* nav + chrome */
    "Command Center": "مركز القيادة", "Analytics": "التحليلات", "Materials": "المواد",
    "Suppliers": "الموردون", "Offers": "العروض", "Purchase Requests": "طلبات الشراء",
    "Contracts": "العقود", "Attendance": "الحضور", "Notifications": "الإشعارات",
    "Settings": "الإعدادات", "Procurement": "المشتريات", "Overview": "نظرة عامة",
    "Workspace": "مساحة العمل", "All sites": "كل المواقع", "All sites (God mode)": "كل المواقع (وضع المدير)",
    /* common actions / words */
    "Sign out": "تسجيل الخروج", "Sign in": "تسجيل الدخول", "Save": "حفظ", "Cancel": "إلغاء",
    "Delete": "حذف", "Create": "إنشاء", "Add": "إضافة", "Edit": "تعديل", "Close": "إغلاق",
    "Search": "بحث", "View": "عرض", "View all →": "عرض الكل ←", "Review": "مراجعة",
    "Approve": "موافقة", "Reject": "رفض", "Submit": "إرسال", "Confirm": "تأكيد",
    "Active": "نشط", "Status": "الحالة", "Date": "التاريخ", "Name": "الاسم",
    "Live": "مباشر", "Offline": "غير متصل", "Amount": "المبلغ", "Description": "الوصف",
    "Total": "الإجمالي", "Phone": "الهاتف", "Email": "البريد الإلكتروني", "Location": "الموقع",
    "Role": "الدور", "Hours": "الساعات", "Site": "الموقع", "Pending": "معلق",
    "Approved": "موافق عليه", "Rejected": "مرفوض", "Submitted": "مُقدّم", "Loading…": "جارٍ التحميل…",
    /* dashboard */
    "Pending Approvals": "الموافقات المعلقة", "Active Offers": "العروض النشطة",
    "Materials Catalog": "كتالوج المواد", "Monthly Spend (OMR)": "الإنفاق الشهري (ر.ع)",
    "Critical Stock Alerts": "تنبيهات المخزون الحرجة", "Action Center": "مركز الإجراءات",
    "needs your attention": "يحتاج انتباهك", "Spend by Category": "الإنفاق حسب الفئة",
    "Monthly Spend Trend": "اتجاه الإنفاق الشهري", "Top Suppliers by Volume": "أهم الموردين حسب الحجم",
    "Recent Activity": "النشاط الأخير", "Request Quote": "طلب عرض سعر",
    /* suppliers */
    "Vendor intelligence": "ذكاء الموردين", "New Supplier": "مورد جديد", "Request Offer": "طلب عرض",
    "View Details": "عرض التفاصيل", "WhatsApp": "واتساب", "Score": "التقييم",
    "Company / Supplier name": "اسم الشركة / المورد", "All Contracts": "كل العقود",
    "E-contracts & signatures": "العقود الإلكترونية والتواقيع",
    /* contracts + PSI */
    "Contract title": "عنوان العقد", "Contractor name": "اسم المقاول",
    "Contractor phone": "هاتف المقاول", "Contract value": "قيمة العقد",
    "Start date": "تاريخ البداية", "End date": "تاريخ النهاية", "Scope of work": "نطاق العمل",
    "Terms & conditions": "الشروط والأحكام", "New Contract": "عقد جديد", "Draft": "مسودة",
    "Signed": "موقّع", "Send to contractor": "إرسال للمقاول", "Print": "طباعة",
    "Sign contract": "توقيع العقد", "Full name": "الاسم الكامل", "Clear": "مسح",
    "Pre-Shipment Inspection": "الفحص قبل الشحن", "Inspection date": "تاريخ الفحص",
    "Inspector name": "اسم المفتش", "Item inspected": "الصنف المفحوص", "Result": "النتيجة",
    "Pass": "ناجح", "Fail": "راسب", "Notes": "ملاحظات", "Photo": "صورة",
    "PSI History": "سجل الفحص", "Add PSI Record": "إضافة سجل فحص",
    "Expiry Alerts": "تنبيهات الانتهاء", "Contracts ending soon": "عقود تنتهي قريباً",
    "No contracts yet": "لا توجد عقود بعد", "Details": "التفاصيل",
    /* attendance */
    "Sign In": "تسجيل الدخول", "Sign Out": "تسجيل الخروج", "Present": "حاضر",
    "Absent": "غائب", "Incomplete": "غير مكتمل", "Time In": "وقت الدخول",
    "Time Out": "وقت الخروج", "Total Hours": "إجمالي الساعات", "Contractors": "المقاولون",
    "Attendance Dashboard": "لوحة الحضور", "Live Map": "الخريطة المباشرة",
    "GPS sign-in & out": "تسجيل الدخول والخروج عبر GPS",
    "Daily attendance": "الحضور اليومي", "Geofence Setup": "إعداد النطاق الجغرافي",
    "Use my current location": "استخدم موقعي الحالي", "Radius (m)": "النطاق (متر)",
    "Latitude": "خط العرض", "Longitude": "خط الطول", "Contractor": "مقاول",
    "Not signed in": "لم يسجل الدخول", "Completed": "مكتمل",
    /* settings */
    "Sites": "المواقع", "User Management": "إدارة المستخدمين", "Approval Matrix": "مصفوفة الموافقات",
    "Appearance": "المظهر", "Backup & Export": "النسخ الاحتياطي والتصدير",
    "Danger Zone": "منطقة الخطر", "New Site": "موقع جديد", "Create User": "إنشاء مستخدم",
    "Job Type": "نوع الوظيفة", "Username": "اسم المستخدم", "Password": "كلمة المرور",
    "Site Name": "اسم الموقع", "Administrator": "مدير", "Light": "فاتح", "Dark": "داكن", "Auto": "تلقائي",
    /* login */
    "Welcome back": "مرحباً بعودتك", "Create administrator": "إنشاء مدير",
    "Procurement & Construction": "المشتريات والإنشاءات"
  };
  var REV = {}; Object.keys(DICT).forEach(function (k) { REV[DICT[k]] = k; });

  /** @returns {string} current language code ("en"|"ar"). */
  function getLang() { return localStorage.getItem(LANG_KEY) || "en"; }

  /** Translate an English key for the current language. @param {string} k @returns {string} */
  function tr(k) {
    if (getLang() === "ar" && DICT[k]) { return DICT[k]; }
    return k;
  }

  /** Set document direction + lang attribute for the current language. */
  function applyDir() {
    var ar = getLang() === "ar";
    document.documentElement.setAttribute("dir", ar ? "rtl" : "ltr");
    document.documentElement.setAttribute("lang", ar ? "ar" : "en");
  }

  /** Inject minimal, safe RTL layout overrides once. */
  function injectRtlStyle() {
    if (document.getElementById("nexusRtlStyle")) { return; }
    var st = document.createElement("style");
    st.id = "nexusRtlStyle";
    st.textContent =
      '[dir="rtl"] body,[dir="rtl"]{text-align:right;}' +
      '[dir="rtl"] .sb{border-right:none;border-left:1px solid var(--border);}' +
      '[dir="rtl"] .tb-actions{margin-left:0;margin-right:auto;}' +
      '[dir="rtl"] .search-ico{left:auto;right:13px;}' +
      '[dir="rtl"] .search-box{padding:0 40px 0 14px;}' +
      '[dir="rtl"] .nav-badge{margin-left:0;margin-right:auto;}';
    document.head.appendChild(st);
  }

  /**
   * Translate the visible DOM under root by exact whole-string match
   * (text nodes + placeholder/title/aria-label). Reversible via the EN↔AR maps.
   * @param {Node} root
   */
  function translateDOM(root) {
    root = root || document.body;
    if (!root) { return; }
    var map = getLang() === "ar" ? DICT : REV;
    var skip = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, CANVAS: 1 };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) { nodes.push(n); }
    nodes.forEach(function (node) {
      if (node.parentNode && skip[node.parentNode.nodeName]) { return; }
      var raw = node.nodeValue, key = raw.trim();
      if (key && map[key]) { node.nodeValue = raw.replace(key, map[key]); }
    });
    ["placeholder", "title", "aria-label"].forEach(function (attr) {
      var els = root.querySelectorAll ? root.querySelectorAll("[" + attr + "]") : [];
      els.forEach(function (el) {
        var v = el.getAttribute(attr), key = (v || "").trim();
        if (key && map[key]) { el.setAttribute(attr, v.replace(key, map[key])); }
      });
    });
  }

  var _i18nObserving = false, _i18nTimer = null;
  /**
   * Keep Arabic applied to content rendered AFTER initial load (lists, modals,
   * tables that re-render). Watches structural DOM changes and re-translates,
   * debounced, only while the language is Arabic. Text-node edits don't fire
   * childList mutations, so this can't loop.
   */
  function startI18nObserver() {
    if (_i18nObserving || !document.body) { return; }
    _i18nObserving = true;
    var obs = new MutationObserver(function () {
      if (getLang() !== "ar") { return; }
      clearTimeout(_i18nTimer);
      _i18nTimer = setTimeout(function () { translateDOM(document.body); }, 60);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /** Switch language, persist, apply direction, and re-translate. @param {string} l */
  function setLang(l) {
    localStorage.setItem(LANG_KEY, l === "ar" ? "ar" : "en");
    applyDir();
    injectRtlStyle();
    translateDOM(document.body);
    var b = document.getElementById("nexusLangBtn");
    if (b) { b.textContent = getLang() === "ar" ? "EN" : "ع"; }
  }

  /** Inject the EN/AR toggle into the topbar actions area (once). */
  function injectLangToggle() {
    var host = document.querySelector(".tb-actions");
    if (!host || document.getElementById("nexusLangBtn")) { return; }
    var b = document.createElement("button");
    b.id = "nexusLangBtn";
    b.className = "icon-btn";
    b.setAttribute("aria-label", "Toggle language");
    b.style.fontWeight = "800";
    b.textContent = getLang() === "ar" ? "EN" : "ع";
    b.addEventListener("click", function () { setLang(getLang() === "ar" ? "en" : "ar"); });
    host.appendChild(b);
  }

  var _observing = false;

  /**
   * One-call chrome setup for a module: inject the new nav links, filter the
   * nav by permission, inject the site switcher + language toggle, translate,
   * and keep all of it applied across later shell re-renders.
   * Safe to call after renderShell().
   * @param {string} current - module CURRENT nav id.
   */
  function applyChrome(current) {
    if (current) { global.CURRENT = current; }
    ensureNavItems();
    filterNav();
    injectSiteSwitcher();
    injectLangToggle();
    applyDir();
    injectRtlStyle();
    translateDOM(document.body);
    startI18nObserver();
    if (!_observing) {
      _observing = true;
      var sb = document.getElementById("sidebar");
      var bn = document.getElementById("bottomNav");
      var obs = new MutationObserver(function () { ensureNavItems(); filterNav(); });
      if (sb) { obs.observe(sb, { childList: true, subtree: true }); }
      if (bn) { obs.observe(bn, { childList: true, subtree: true }); }
    }
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
    resolveSite: resolveSite,
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
    remove: remove,
    wipe: wipe,
    uploadFile: uploadFile,
    uploadBlob: uploadBlob,
    sendWhatsApp: sendWhatsApp,
    sendEmail: sendEmail,
    haversine: haversine,
    resizeImage: resizeImage,
    t: tr,
    tr: tr,
    getLang: getLang,
    setLang: setLang,
    applyDir: applyDir,
    translateDOM: translateDOM,
    injectLangToggle: injectLangToggle,
    applyIdentity: applyIdentity,
    guardSection: guardSection,
    applyChrome: applyChrome
  };

  /* Auto-apply language/direction on every page (incl. public standalone pages
     such as login.html, offer-submit.html, contract-sign.html that don't call
     applyChrome). Runs once the DOM is ready. */
  function autoInit() {
    applyDir();
    injectRtlStyle();
    translateDOM(document.body);
    injectLangToggle();
    startI18nObserver();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit);
  } else {
    autoInit();
  }
})(window);
