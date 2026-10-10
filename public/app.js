// ---------- state & helpers ----------
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let lookups = { departments: [], types: [] };
let currentPage = 'dashboard';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (d) => (d ? new Date(d).toLocaleString() : '');
const badge = (s) => `<span class="badge ${s}">${s}</span>`;

async function api(url, method = 'GET', body) {
  const res = await fetch('/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { clearSession(); }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- login / logout ----------
function clearSession() {
  token = null; user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const data = await api('/login', 'POST', { username: $('#username').value, password: $('#password').value });
    token = data.token; user = data.user;
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    $('#password').value = '';
    await startApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/logout', 'POST'); } catch (_) {}
  clearSession();
});

// ---------- app start & navigation ----------
async function startApp() {
  try {
    lookups = await api('/lookups');
  } catch (_) { return; }
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#who').textContent = `${user.name} (${user.role}, ${user.dept_name})`;
  document.querySelectorAll('[data-roles]').forEach((el) => {
    el.hidden = !el.dataset.roles.split(',').includes(user.role);
  });
  fillSelect('#r-type', lookups.types);
  fillSelect('#r-dept', lookups.departments.filter((d) => d.is_active));
  showPage('dashboard');
}

function fillSelect(sel, items) {
  $(sel).innerHTML = items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('');
}

$('#nav').addEventListener('click', (e) => {
  if (e.target.dataset.page) showPage(e.target.dataset.page);
});

function showPage(page) {
  currentPage = page;
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'page-' + page));
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  ({ dashboard: loadDashboard, documents: loadDocuments, overdue: loadOverdue, departments: loadDepartments }[page] || (() => {}))();
}

// ---------- dashboard ----------
function bars(rows, key) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return '<p class="muted">No data yet.</p>';
  return rows.map((r) => `<div class="bar-row"><span>${esc(r[key])}</span>
    <div class="bar"><i style="width:${(r.count / max) * 100}%"></i></div><b>${r.count}</b></div>`).join('');
}

async function loadDashboard() {
  const d = await api('/dashboard');
  const n = (s) => (d.byStatus.find((x) => x.status === s) || { count: 0 }).count;
  const pending = n('Registered') + n('Routed') + n('Received') + n('Returned');
  $('#kpis').innerHTML = `
    <div class="kpi"><b>${d.total}</b><span>Total documents</span></div>
    <div class="kpi"><b>${pending}</b><span>In progress</span></div>
    <div class="kpi"><b>${n('Approved')}</b><span>Awaiting release</span></div>
    <div class="kpi"><b>${n('Released')}</b><span>Released</span></div>
    <div class="kpi ${d.overdue ? 'warn' : ''}"><b>${d.overdue}</b><span>Overdue</span></div>`;
  $('#chart-status').innerHTML = bars(d.byStatus, 'status');
  $('#chart-dept').innerHTML = bars(d.byDept, 'name');
}

// ---------- documents ----------
async function loadDocuments() {
  const q = encodeURIComponent($('#search').value);
  const s = encodeURIComponent($('#filter-status').value);
  const rows = await api(`/documents?q=${q}&status=${s}`);
  $('#doc-rows').innerHTML = rows.length
    ? rows.map((r) => `<tr class="click" data-id="${r.id}">
        <td>${esc(r.doc_number)}</td><td>${esc(r.title)}</td><td>${esc(r.type_name)}</td>
        <td>${esc(r.origin_name)}</td><td>${badge(r.status)}</td><td>${fmt(r.created_at)}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="6">No documents found.</td></tr>';
}
$('#search').addEventListener('input', loadDocuments);
$('#filter-status').addEventListener('change', loadDocuments);
$('#doc-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDoc(tr.dataset.id);
});

// ---------- register ----------
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/documents', 'POST', {
      title: $('#r-title').value,
      description: $('#r-desc').value,
      type_id: $('#r-type').value,
      origin_dept_id: $('#r-dept').value,
    });
    toast(`Registered as ${r.doc_number}`);
    e.target.reset();
    showPage('documents');
  } catch (err) { toast(err.message, true); }
});

// ---------- overdue ----------
async function loadOverdue() {
  const { days, rows } = await api('/overdue');
  $('#overdue-note').textContent = `Routed documents not received within ${days} days.`;
  $('#overdue-rows').innerHTML = rows.length
    ? rows.map((r) => `<tr class="click" data-id="${r.id}"><td>${esc(r.doc_number)}</td><td>${esc(r.title)}</td>
        <td>${esc(r.to_name)}</td><td>${fmt(r.routed_at)}</td><td>${r.days_pending}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="5">No overdue documents.</td></tr>';
}
$('#overdue-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDoc(tr.dataset.id);
});

// ---------- departments ----------
async function loadDepartments() {
  lookups = await api('/lookups');
  const isAdmin = user.role === 'admin';
  $('#dept-rows').innerHTML = lookups.departments.map((d) => `<tr>
    <td>${esc(d.name)}</td><td>${d.is_active ? 'Active' : 'Inactive'}</td>
    <td>${isAdmin ? `<button class="ghost" data-toggle="${d.id}">${d.is_active ? 'Deactivate' : 'Activate'}</button>` : ''}</td></tr>`).join('');
  fillSelect('#r-dept', lookups.departments.filter((d) => d.is_active));
}
$('#dept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/departments', 'POST', { name: $('#dept-name').value });
    e.target.reset();
    loadDepartments();
  } catch (err) { toast(err.message, true); }
});
$('#dept-rows').addEventListener('click', async (e) => {
  if (!e.target.dataset.toggle) return;
  await api(`/departments/${e.target.dataset.toggle}/toggle`, 'PUT');
  loadDepartments();
});

// ---------- document profile (modal) ----------
$('#modal-close').addEventListener('click', () => ($('#modal').hidden = true));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

function routeForm(label) {
  const opts = lookups.departments
    .filter((d) => d.is_active && d.id !== user.department_id)
    .map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  return `<div class="action-box"><h3>${label}</h3>
    <label>Send to <select id="f-dept">${opts}</select></label>
    <label>Purpose <input id="f-purpose" placeholder="e.g. For review"></label>
    <label>Instructions <textarea id="f-instr" rows="2"></textarea></label>
    <button data-action="route">Route document</button></div>`;
}

async function openDoc(id) {
  let data;
  try { data = await api('/documents/' + id); } catch (err) { return toast(err.message, true); }
  const { doc, routing, approvals, releases, history } = data;
  const pending = routing.find((r) => r.status === 'Pending');
  const last = routing[routing.length - 1];
  const isAdmin = user.role === 'admin';
  const isClerk = ['admin', 'clerk'].includes(user.role);
  let actions = '';

  if (['Registered', 'Returned'].includes(doc.status) && isClerk) actions += routeForm('Route this document');
  if (doc.status === 'Routed' && pending && (isAdmin || user.department_id === pending.to_dept_id)) {
    actions += `<div class="action-box"><h3>Receive this document</h3>
      <label>Remarks <textarea id="f-remarks" rows="2" placeholder="Required when returning"></textarea></label>
      <div class="btn-row">
        <button data-action="receive" data-rid="${pending.id}">Receive</button>
        <button class="danger" data-action="return" data-rid="${pending.id}">Return to sender</button>
      </div></div>`;
  }
  if (doc.status === 'Received') {
    if (['admin', 'approver'].includes(user.role)) {
      actions += `<div class="action-box"><h3>Approval decision</h3>
        <label>Comments <textarea id="f-comments" rows="2" placeholder="Required when rejecting"></textarea></label>
        <div class="btn-row">
          <button data-action="approve">Approve</button>
          <button class="danger" data-action="reject">Reject</button>
        </div></div>`;
    }
    if (isAdmin || (last && user.department_id === last.to_dept_id)) actions += routeForm('Route onward');
  }
  if (doc.status === 'Approved' && isClerk) {
    actions += `<div class="action-box"><h3>Release this document</h3>
      <label>Released to <input id="f-to"></label>
      <label>Remarks <input id="f-rel-remarks"></label>
      <button data-action="release">Release document</button></div>`;
  }

  const routingRows = routing.length
    ? routing.map((r) => `<tr><td>${esc(r.from_name)} &rarr; ${esc(r.to_name)}</td><td>${esc(r.purpose || '')}</td>
        <td>${badge(r.status)}</td><td>${r.received_by_name ? esc(r.received_by_name) + '<br><small>' + fmt(r.received_at) + '</small>' : ''}</td>
        <td>${esc(r.remarks || '')}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="5">Not routed yet.</td></tr>';

  $('#modal-body').dataset.id = doc.id;
  $('#modal-body').innerHTML = `
    <h2>${esc(doc.doc_number)} ${badge(doc.status)}</h2>
    <h3>${esc(doc.title)}</h3>
    <dl class="meta">
      <div><dt>Type</dt><dd>${esc(doc.type_name)}</dd></div>
      <div><dt>Origin</dt><dd>${esc(doc.origin_name)}</dd></div>
      <div><dt>Registered by</dt><dd>${esc(doc.created_by_name)}</dd></div>
      <div><dt>Registered on</dt><dd>${fmt(doc.created_at)}</dd></div>
    </dl>
    ${doc.description ? `<p>${esc(doc.description)}</p>` : ''}
    ${actions}
    <h3>Routing</h3>
    <table><thead><tr><th>Route</th><th>Purpose</th><th>Status</th><th>Handled by</th><th>Remarks</th></tr></thead>
      <tbody>${routingRows}</tbody></table>
    ${approvals.length ? `<h3 style="margin-top:1rem">Approvals</h3><table><thead><tr><th>Approver</th><th>Decision</th><th>Comments</th><th>Date</th></tr></thead><tbody>
      ${approvals.map((a) => `<tr><td>${esc(a.approver_name)}</td><td>${badge(a.decision)}</td><td>${esc(a.comments || '')}</td><td>${fmt(a.decided_at)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${releases.length ? `<h3 style="margin-top:1rem">Release</h3><table><thead><tr><th>Released to</th><th>By</th><th>Remarks</th><th>Date</th></tr></thead><tbody>
      ${releases.map((r) => `<tr><td>${esc(r.released_to)}</td><td>${esc(r.released_by_name)}</td><td>${esc(r.remarks || '')}</td><td>${fmt(r.released_at)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="margin-top:1rem">Tracking history</h3>
    <ul class="timeline">${history.map((h) => `<li><b>${esc(h.action)}</b> &ndash; ${esc(h.details || '')}
      <small>${esc(h.user_name)}, ${fmt(h.created_at)}</small></li>`).join('')}</ul>`;
  $('#modal').hidden = false;
}

// buttons inside the profile
$('#modal-body').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const id = $('#modal-body').dataset.id;
  const v = (n) => ($('#f-' + n) || {}).value || '';
  try {
    if (action === 'route') await api(`/documents/${id}/route`, 'POST', { to_dept_id: v('dept'), purpose: v('purpose'), instructions: v('instr') });
    if (action === 'receive') await api(`/routing/${e.target.dataset.rid}/receive`, 'POST', { remarks: v('remarks') });
    if (action === 'return') await api(`/routing/${e.target.dataset.rid}/return`, 'POST', { remarks: v('remarks') });
    if (action === 'approve') await api(`/documents/${id}/approve`, 'POST', { decision: 'Approved', comments: v('comments') });
    if (action === 'reject') await api(`/documents/${id}/approve`, 'POST', { decision: 'Rejected', comments: v('comments') });
    if (action === 'release') await api(`/documents/${id}/release`, 'POST', { released_to: v('to'), remarks: v('rel-remarks') });
    toast('Saved.');
    await openDoc(id);
    showPage(currentPage);
  } catch (err) { toast(err.message, true); }
});

// ---------- init ----------
if (token && user) startApp();
