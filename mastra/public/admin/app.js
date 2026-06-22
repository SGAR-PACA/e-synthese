function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

var csrfToken = sessionStorage.getItem('csrfToken') || null;
var currentUser = null;

async function checkAuth() {
  var res = await fetch('/admin/auth-status');
  var data = await res.json();
  var publicPages = ['/admin/login', '/admin/register', '/admin/forgot-password', '/admin/reset-password'];
  var isPublicPage = publicPages.some(function(p) { return location.pathname.includes(p); });

  if (!data.isSetup && !location.pathname.includes('/admin/login')) {
    location.href = '/admin/login';
    return null;
  }
  if (data.isSetup && !data.isAuthenticated && !isPublicPage) {
    location.href = '/admin/login';
    return null;
  }
  if (data.isAuthenticated) {
    var me = await fetch('/admin/me');
    if (me.ok) currentUser = await me.json();
  }
  return data;
}

async function loginUser(email, password) {
  var res = await fetch('/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  });
  var data = await res.json();
  if (data.csrfToken) { csrfToken = data.csrfToken; sessionStorage.setItem('csrfToken', csrfToken); }
  return data;
}

async function setupAdmin(email, password) {
  var res = await fetch('/admin/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: password }),
  });
  var data = await res.json();
  if (data.csrfToken) { csrfToken = data.csrfToken; sessionStorage.setItem('csrfToken', csrfToken); }
  return data;
}

async function logout() {
  await fetch('/admin/logout', { method: 'POST' });
  csrfToken = null;
  currentUser = null;
  sessionStorage.removeItem('csrfToken');
  location.href = '/admin/login';
}

function csrfHeaders() {
  var h = { 'Content-Type': 'application/json' };
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  return h;
}

async function apiGet(path) {
  var res = await fetch(path);
  if (res.status === 401) { location.href = '/admin/login'; return null; }
  return res.json();
}

async function apiPost(path, body) {
  var res = await fetch(path, { method: 'POST', headers: csrfHeaders(), body: JSON.stringify(body) });
  if (res.status === 401) { location.href = '/admin/login'; return null; }
  if (res.status === 403) { showMessage('msg', 'Action non autorisee', true); return null; }
  return res.json();
}

async function apiPut(path, body) {
  var res = await fetch(path, { method: 'PUT', headers: csrfHeaders(), body: JSON.stringify(body) });
  if (res.status === 401) { location.href = '/admin/login'; return null; }
  if (res.status === 403) { showMessage('msg', 'Action non autorisee', true); return null; }
  return res.json();
}

async function apiDelete(path) {
  var res = await fetch(path, { method: 'DELETE', headers: csrfHeaders() });
  if (res.status === 401) { location.href = '/admin/login'; return null; }
  if (res.status === 403) { showMessage('msg', 'Action non autorisee', true); return null; }
  return res.json();
}

function showMessage(elementId, message, isError) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className = isError ? 'message error' : 'message success';
  el.style.display = 'block';
  if (!isError) setTimeout(function() { el.style.display = 'none'; }, 5000);
}

function createEl(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) {
    for (var key of Object.keys(attrs)) {
      var val = attrs[key];
      if (key === 'textContent') el.textContent = val;
      else if (key === 'className') el.className = val;
      else if (key.startsWith('on') && key.length > 2) el.addEventListener(key.slice(2).toLowerCase(), val);
      else el.setAttribute(key, val);
    }
  }
  if (children) {
    for (var child of children) {
      if (typeof child === 'string') el.appendChild(document.createTextNode(child));
      else if (child) el.appendChild(child);
    }
  }
  return el;
}

function clearEl(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function buildNav(activePage) {
  var nav = document.getElementById('main-nav');
  if (!nav || !currentUser) return;
  clearEl(nav);

  nav.appendChild(createEl('span', { className: 'brand', textContent: 'E-Synthese Admin' }));

  var links = [{ href: '/admin/', label: 'Dashboard', page: 'dashboard' }];

  if (currentUser.role === 'admin') {
    links.push({ href: '/admin/settings', label: 'Configuration', page: 'config' });
    links.push({ href: '/admin/collections', label: 'Collections', page: 'collections' });
  }

  links.push({ href: '/admin/documents', label: 'Documents', page: 'documents' });
  links.push({ href: '/admin/test', label: 'Test Pipeline', page: 'test' });

  if (currentUser.role === 'admin') {
    links.push({ href: '/admin/users-page', label: 'Utilisateurs', page: 'users' });
    links.push({ href: '/admin/audit-page', label: 'Audit', page: 'audit' });
    links.push({ href: '/admin/eval', label: 'Évaluation', page: 'eval' });
    links.push({ href: '/admin/ratings-page', label: 'Notes', page: 'ratings' });
  }

  links.push({ href: '/admin/account', label: 'Mon compte', page: 'me' });

  var ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    config: '<line x1="21" y1="6" x2="3" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="21" y1="12" x2="3" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="21" y1="18" x2="3" y2="18"/><circle cx="9" cy="18" r="2"/>',
    collections: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    documents: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    test: '<path d="M10 2v7.5L4.5 19a1.5 1.5 0 0 0 1.3 2.3h12.4a1.5 1.5 0 0 0 1.3-2.3L14 9.5V2"/><line x1="8.5" y1="2" x2="15.5" y2="2"/><line x1="7" y1="15" x2="17" y2="15"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    audit: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    eval: '<line x1="6" y1="20" x2="6" y2="15"/><line x1="12" y1="20" x2="12" y2="9"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="3" y1="20" x2="21" y2="20"/>',
    ratings: '<polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.7 5.8 21 7 14 2 9.3 9 8.5 12 2"/>',
    me: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'
  };
  function navSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  links.forEach(function(link) {
    var a = createEl('a', { href: link.href });
    a.innerHTML = navSvg(link.page) + '<span>' + link.label + '</span>';
    if (link.page === activePage) a.className = 'active';
    nav.appendChild(a);
  });

  var logoutLink = createEl('a', { href: '#', onClick: function(e) { e.preventDefault(); logout(); } });
  logoutLink.innerHTML = navSvg('logout') + '<span>Deconnexion</span>';
  nav.appendChild(logoutLink);
}

function validatePasswordClient(pw) {
  if (!pw || pw.length < 8) return 'Le mot de passe doit contenir au moins 8 caracteres';
  if (!/[0-9]/.test(pw)) return 'Le mot de passe doit contenir au moins 1 chiffre';
  if (!/[A-Z]/.test(pw)) return 'Le mot de passe doit contenir au moins 1 majuscule';
  return null;
}
