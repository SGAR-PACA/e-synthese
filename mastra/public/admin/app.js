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
  }

  links.push({ href: '/admin/account', label: 'Mon compte', page: 'me' });

  links.forEach(function(link) {
    var a = createEl('a', { href: link.href, textContent: link.label });
    if (link.page === activePage) a.className = 'active';
    nav.appendChild(a);
  });

  var logoutLink = createEl('a', { href: '#', textContent: 'Deconnexion', onClick: function(e) { e.preventDefault(); logout(); } });
  nav.appendChild(logoutLink);
}

function validatePasswordClient(pw) {
  if (!pw || pw.length < 8) return 'Le mot de passe doit contenir au moins 8 caracteres';
  if (!/[0-9]/.test(pw)) return 'Le mot de passe doit contenir au moins 1 chiffre';
  if (!/[A-Z]/.test(pw)) return 'Le mot de passe doit contenir au moins 1 majuscule';
  return null;
}
