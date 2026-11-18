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
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) {
    throw new Error('Cannot reach the server. Check your internet connection and that the system is running, then try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { clearSession(); }
  // WP25: the admin reset this password, so the user must choose a new one first
  if (data.must_change && user && !user.must_change) {
    user.must_change = true;
    localStorage.setItem('user', JSON.stringify(user));
    showForcedPasswordChange();
  }
  if (!res.ok) throw new Error(data.error || (res.status === 413 ? 'The data you sent is too large.' : `The request failed (error ${res.status}). Please try again.`));
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
  $('#login-form').hidden = false;
  $('#forgot-form').hidden = true;
  $('#modal').hidden = true;
  showChrome(true);
}

// the menu, bell and Change password button are hidden while a forced password change is open
function showChrome(on) {
  ['#nav', '#bell', '#change-pw', '#modal-close'].forEach((s) => ($(s).hidden = !on));
}

// ---------- forgot password (WP25) ----------
$('#forgot-link').addEventListener('click', (e) => {
  e.preventDefault();
  $('#forgot-username').value = $('#username').value;
  $('#forgot-msg').textContent = '';
  $('#login-form').hidden = true;
  $('#forgot-form').hidden = false;
});
$('#forgot-back').addEventListener('click', (e) => {
  e.preventDefault();
  $('#forgot-form').hidden = true;
  $('#login-form').hidden = false;
});
$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#forgot-msg');
  msg.className = 'error';
  msg.textContent = '';
  try {
    const d = await api('/forgot-password', 'POST', { username: $('#forgot-username').value });
    msg.className = 'success';
    msg.textContent = d.message;
  } catch (err) { msg.textContent = err.message; }
});

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
  if (user.must_change) return showForcedPasswordChange();
  showChrome(true);
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
  fillSelect('#r-sender', lookups.senders);
  showPage('dashboard');
  loadBell();
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
  ({ dashboard: loadDashboard, documents: loadDocuments, overdue: loadOverdue, departments: loadDepartments, people: loadPeople, users: loadUsers, levels: loadLevels, audit: () => loadAudit(1), register: loadRegister, doctypes: loadDocTypes, inbox: loadInbox, releases: loadReleases, reports: () => loadReports() }[page] || (() => {}))();
}

// ---------- dashboard ----------
function bars(rows, key) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  if (!rows.length) return '<p class="muted">No data yet.</p>';
  return rows.map((r) => `<div class="bar-row"><span>${esc(r[key])}</span>
    <div class="bar"><i style="width:${(r.count / max) * 100}%"></i></div><b>${r.count}</b></div>`).join('');
}

// WP24: charts (plain HTML and SVG, no library)
function monthlyChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const W = 360, H = 170, top = 22, base = 135, bw = 36, gap = (W - rows.length * bw) / (rows.length + 1);
  const cols = rows.map((r, i) => {
    const h = Math.round((r.count / max) * (base - top));
    const x = Math.round(gap + i * (bw + gap));
    return `<rect class="mcol" x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="3" fill="#14595b"/>
      <text class="mnum" x="${x + bw / 2}" y="${base - h - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="#1d2939">${r.count}</text>
      <text class="mlab" x="${x + bw / 2}" y="${base + 17}" text-anchor="middle" font-size="12" fill="#667085">${esc(r.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Documents registered per month">
    <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="#d0d5dd"/>${cols}</svg>`;
}

function approvalBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.approved + r.rejected));
  return rows.map((r) => `<div class="bar-row wide"><span>${esc(r.name)}</span>
    <div class="bar stack"><i class="ok" style="width:${(r.approved / max) * 100}%"></i><i class="no" style="width:${(r.rejected / max) * 100}%"></i></div>
    <b>${r.approved + r.rejected}</b></div>
    <div class="bar-note">${r.approved} approved, ${r.rejected} rejected</div>`).join('');
}

function routingBars(rows) {
  if (!rows.length) return '<p class="muted">No routed documents yet.</p>';
  const max = Math.max(0.1, ...rows.map((r) => r.avg_days || 0));
  return rows.map((r) => `<div class="bar-row wide"><span>${esc(r.name)}</span>
    <div class="bar"><i style="width:${((r.avg_days || 0) / max) * 100}%"></i></div>
    <b>${r.avg_days === null ? '-' : r.avg_days}</b></div>
    <div class="bar-note">${r.routed} routed in, ${r.pending} pending${r.overdue ? `, <span class="late">${r.overdue} overdue</span>` : ''}</div>`).join('');
}

async function loadDashboard() {
  const d = await api('/dashboard');
  const n = (s) => (d.byStatus.find((x) => x.status === s) || { count: 0 }).count;
  const pending = n('Registered') + n('Routed') + n('Received') + n('Returned');
  const kpi = (value, label, cls = '') => `<div class="kpi ${cls}"><b>${value}</b><span>${label}</span></div>`;
  $('#kpis').innerHTML = kpi(d.total, 'Total documents') + kpi(pending, 'In progress') + kpi(n('Approved'), 'Awaiting release')
    + kpi(n('Released'), 'Released') + kpi(n('Archived'), 'Archived') + kpi(n('Rejected'), 'Rejected')
    + kpi(d.overdue, 'Overdue', d.overdue ? 'warn' : '')
    + kpi(d.release_avg_days === null ? '-' : d.release_avg_days, 'Average days to release');
  $('#chart-status').innerHTML = bars(d.byStatus, 'status');
  $('#chart-dept').innerHTML = bars(d.byDept, 'name');
  $('#chart-type').innerHTML = bars(d.byType, 'name');
  $('#chart-monthly').innerHTML = monthlyChart(d.monthly);
  $('#chart-approval').innerHTML = `<p class="muted">Waiting for approval now: <b>${n('Received')}</b></p>` + approvalBars(d.approval);
  $('#chart-routing').innerHTML = routingBars(d.routing);
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
      sender_id: $('#r-sender').value,
    });
    toast(`Registered as ${r.doc_number}`);
    e.target.reset();
    showPage('documents');
  } catch (err) { toast(err.message, true); }
});

// ---------- overdue ----------
async function loadOverdue() {
  const { days, rows } = await api('/overdue');
  $('#overdue-note').textContent = `Routed documents not received within ${days} days, or past their due date.`;
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
  const q = $('#dept-search').value.toLowerCase();
  const list = lookups.departments.filter((d) => d.name.toLowerCase().includes(q));
  $('#dept-rows').innerHTML = list.length
    ? list.map((d) => `<tr>
        <td>${esc(d.name)}</td><td>${d.is_active ? 'Active' : 'Inactive'}</td>
        <td>${isAdmin ? `<button class="ghost" data-edit="${d.id}">Edit</button>
          <button class="ghost" data-toggle="${d.id}">${d.is_active ? 'Deactivate' : 'Activate'}</button>
          <button class="ghost" data-delete="${d.id}">Delete</button>` : ''}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="3">No departments found.</td></tr>';
  fillSelect('#r-dept', lookups.departments.filter((d) => d.is_active));
}
$('#dept-search').addEventListener('input', loadDepartments);
$('#dept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/departments', 'POST', { name: $('#dept-name').value });
    e.target.reset();
    loadDepartments();
  } catch (err) { toast(err.message, true); }
});
$('#dept-rows').addEventListener('click', async (e) => {
  const { toggle, edit, delete: del } = e.target.dataset;
  try {
    if (toggle) await api(`/departments/${toggle}/toggle`, 'PUT');
    if (edit) {
      const cur = lookups.departments.find((d) => d.id == edit);
      const name = prompt('New department name:', cur.name);
      if (!name) return;
      await api(`/departments/${edit}`, 'PUT', { name });
    }
    if (del) {
      if (!confirm('Delete this department?')) return;
      await api(`/departments/${del}`, 'DELETE');
    }
    loadDepartments();
  } catch (err) { toast(err.message, true); }
});

// ---------- document profile (modal) ----------
$('#modal-close').addEventListener('click', () => ($('#modal').hidden = true));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' && !(user && user.must_change)) $('#modal').hidden = true; });

function routeForm(label) {
  const opts = lookups.departments
    .filter((d) => d.is_active && d.id !== user.department_id)
    .map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `<div class="action-box"><h3>${label}</h3>
    <label>Send to <select id="f-dept">${opts}</select></label>
    <label>Assigned receiver <select id="f-receiver"></select></label>
    <label>Due date (optional) <input id="f-due" type="date" min="${today}"></label>
    <label>Purpose <input id="f-purpose" placeholder="e.g. For review"></label>
    <label>Instructions <textarea id="f-instr" rows="2"></textarea></label>
    <button data-action="route">Route document</button></div>`;
}

// show only the active receivers of the chosen department
function refreshReceivers() {
  const sel = $('#f-receiver');
  const dept = $('#f-dept');
  if (!sel || !dept) return;
  const list = lookups.receivers.filter((r) => r.department_id == dept.value);
  sel.innerHTML = list.length
    ? list.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')
    : '<option value="">No active receiver in this department</option>';
}

async function openDoc(id) {
  let data;
  try { lookups = await api('/lookups'); data = await api('/documents/' + id); } catch (err) { return toast(err.message, true); }
  const { doc, routing, approvals, releases, files, history, approval } = data;
  const pending = routing.find((r) => r.status === 'Pending');
  const last = routing[routing.length - 1];
  const isAdmin = user.role === 'admin';
  const isClerk = ['admin', 'clerk'].includes(user.role);
  let actions = '';

  if (['Registered', 'Returned'].includes(doc.status) && isClerk) actions += routeForm('Route this document');
  if (doc.status === 'Routed' && pending && (isAdmin || user.department_id === pending.to_dept_id)) {
    actions += `<div class="action-box"><h3>Receive this document</h3>
      <label>Remarks <textarea id="f-remarks" rows="2" placeholder="Required when returning or rejecting"></textarea></label>
      <div class="btn-row">
        <button data-action="receive" data-rid="${pending.id}">Receive</button>
        <button class="danger" data-action="return" data-rid="${pending.id}">Return to sender</button>
        <button class="danger" data-action="reject-routing" data-rid="${pending.id}">Reject</button>
      </div></div>`;
  }
  if (doc.status === 'Received') {
    if (approval && approval.can_decide) {
      actions += `<div class="action-box"><h3>Approval decision - Level ${approval.next.level_no}: ${esc(approval.next.name)}</h3>
        ${approval.note ? `<p class="muted">${esc(approval.note)}</p>` : ''}
        <label>Comments <textarea id="f-comments" rows="2" placeholder="Required when rejecting"></textarea></label>
        <div class="btn-row">
          <button data-action="approve">Approve</button>
          <button class="danger" data-action="reject">Reject</button>
        </div></div>`;
    } else if (approval && approval.note) {
      actions += `<div class="action-box"><h3>Approval</h3><p class="muted">${esc(approval.note)}</p></div>`;
    }
    if (isAdmin || (last && user.department_id === last.to_dept_id)) actions += routeForm('Route onward');
  }
  if (doc.status === 'Approved' && isClerk) {
    actions += `<div class="action-box"><h3>Release this document</h3>
      <label>Released to <input id="f-to"></label>
      <label>Remarks <input id="f-rel-remarks"></label>
      <button data-action="release">Release document</button></div>`;
  }
  if (doc.status === 'Released' && isClerk) {
    actions += `<div class="action-box"><h3>Archive this document</h3>
      <p class="muted">Archiving closes the life cycle of the document. It cannot be undone.</p>
      <button data-action="archive">Archive document</button></div>`;
  }

  // WP20: visual tracking timeline (Registered > Routed > Received > Approved > Released > Archived)
  const stageAt = (name) => { const hs = history.filter((h) => h.action === name); return hs.length ? hs[hs.length - 1] : null; };
  let timeline = ['Registered', 'Routed', 'Received', 'Approved', 'Released', 'Archived'].map((s) => {
    const hit = stageAt(s);
    const cls = doc.status === s ? 'current' : hit ? 'done' : '';
    return `<div class="step ${cls}"><b>${s}</b><small>${hit ? fmt(hit.created_at) : 'Not yet'}</small></div>`;
  }).join('');
  if (['Returned', 'Rejected'].includes(doc.status)) {
    const hit = stageAt(doc.status);
    timeline += `<div class="step rejected"><b>${doc.status}</b><small>${hit ? fmt(hit.created_at) : ''}</small></div>`;
  }
  timeline = `<h3 style="margin-top:1rem">Tracking timeline <span class="live" title="This screen updates by itself every 10 seconds">&#9679; Live</span></h3>
    <div class="steps">${timeline}</div>`;

  const progress = approval ? `<h3 style="margin-top:1rem">Approval progress</h3><div class="steps">${approval.chain.map((l) => {
    const current = doc.status === 'Received' && approval.next && approval.next.id === l.id;
    const cls = l.state === 'Approved' ? 'done' : l.state === 'Rejected' ? 'rejected' : current ? 'current' : '';
    const word = l.state === 'Approved' ? 'Approved' : l.state === 'Rejected' ? 'Rejected' : current ? 'Waiting' : 'Pending';
    return `<div class="step ${cls}"><b>Level ${l.level_no}</b><span>${esc(l.name)}</span><small>${word}</small></div>`;
  }).join('')}</div>` : '';

  const FILE_ACCEPT = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.gif,.webp';
  const canFiles = ['admin', 'clerk', 'sender'].includes(user.role) && !['Released', 'Archived'].includes(doc.status);
  const fileRows = files.length ? files.map((f) => `<tr>
      <td>${esc(f.original_name)}</td><td>${fmtSize(f.file_size)}</td>
      <td>${esc(f.uploaded_by_name)}<br><small>${fmt(f.uploaded_at)}</small></td>
      <td><button class="ghost" data-action="file-download" data-fid="${f.id}" data-name="${esc(f.original_name)}">Download</button>
        ${canFiles && (user.role !== 'sender' || f.uploaded_by === user.id)
          ? `<button class="ghost" data-action="file-replace" data-fid="${f.id}">Replace</button>
             <button class="ghost" data-action="file-delete" data-fid="${f.id}">Delete</button>` : ''}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="4">No files attached.</td></tr>';
  const filesHtml = `<h3 style="margin-top:1rem">Attachments</h3>
    <table><thead><tr><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>${fileRows}</tbody></table>
    ${canFiles ? `<div class="action-box">
        <label>Attach a file (PDF, DOCX, XLSX or image, max ${lookups.max_file_mb || 4} MB)
          <input type="file" id="upload-input" accept="${FILE_ACCEPT}"></label>
        <button data-action="upload">Upload</button>
        <input type="file" id="replace-input" accept="${FILE_ACCEPT}" hidden>
      </div>` : ''}`;

  const routingRows = routing.length
    ? routing.map((r) => `<tr><td>${esc(r.from_name)} &rarr; ${esc(r.to_name)}</td><td>${esc(r.purpose || '')}</td>
        <td>${esc(r.receiver_name || '-')}</td><td>${esc(r.due_date || '-')}</td>
        <td>${badge(r.status)}</td><td>${r.received_by_name ? esc(r.received_by_name) + '<br><small>' + fmt(r.received_at) + '</small>' : ''}
          ${r.status === 'Received' ? `<br><button class="ghost" data-action="receipt" data-rid="${r.id}">Receipt</button>` : ''}</td>
        <td>${esc(r.remarks || '')}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="7">Not routed yet.</td></tr>';

  $('#modal-body').dataset.id = doc.id;
  $('#modal-body').innerHTML = `
    <h2>${esc(doc.doc_number)} ${badge(doc.status)}</h2>
    <h3>${esc(doc.title)}</h3>
    <dl class="meta">
      <div><dt>Type</dt><dd>${esc(doc.type_name)}</dd></div>
      <div><dt>Origin</dt><dd>${esc(doc.origin_name)}</dd></div>
      <div><dt>Sender</dt><dd>${esc(doc.sender_name || '-')}</dd></div>
      <div><dt>Registered by</dt><dd>${esc(doc.created_by_name)}</dd></div>
      <div><dt>Registered on</dt><dd>${fmt(doc.created_at)}</dd></div>
    </dl>
    ${doc.description ? `<p>${esc(doc.description)}</p>` : ''}
    ${timeline}
    ${actions}
    ${filesHtml}
    <h3 style="margin-top:1rem">Routing</h3>
    <table><thead><tr><th>Route</th><th>Purpose</th><th>Assigned to</th><th>Due</th><th>Status</th><th>Handled by</th><th>Remarks</th></tr></thead>
      <tbody>${routingRows}</tbody></table>
    ${progress}
    ${approvals.length ? `<h3 style="margin-top:1rem">Approvals</h3><table><thead><tr><th>Level</th><th>Approver</th><th>Decision</th><th>Comments</th><th>Date</th></tr></thead><tbody>
      ${approvals.map((a) => `<tr><td>${a.level_no ? `Level ${a.level_no} - ${esc(a.level_name)}` : '-'}</td><td>${esc(a.approver_name)}</td><td>${badge(a.decision)}</td><td>${esc(a.comments || '')}</td><td>${fmt(a.decided_at)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${releases.length ? `<h3 style="margin-top:1rem">Release</h3><table><thead><tr><th>Released to</th><th>By</th><th>Remarks</th><th>Date</th><th></th></tr></thead><tbody>
      ${releases.map((r) => `<tr><td>${esc(r.released_to)}</td><td>${esc(r.released_by_name)}</td><td>${esc(r.remarks || '')}</td><td>${fmt(r.released_at)}</td>
        <td><button class="ghost" data-action="release-slip" data-rid="${r.id}">Confirmation</button></td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="margin-top:1rem">Tracking history</h3>
    <ul class="timeline">${history.map((h) => `<li><b>${esc(h.action)}</b> &ndash; ${esc(h.details || '')}
      <small>${esc(h.user_name)}, ${fmt(h.created_at)}</small></li>`).join('')}</ul>`;
  $('#modal-body').dataset.sig = docSignature(data);
  $('#modal').hidden = false;
  refreshReceivers();
}

// ---------- file helpers ----------
let replaceId = null;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

async function sendFile(url, method, file) {
  const maxMb = lookups.max_file_mb || 4;
  if (file.size > maxMb * 1024 * 1024) throw new Error(`File is too large. The maximum size is ${maxMb} MB.`);
  const fd = new FormData();
  fd.append('file', file);
  let res;
  try {
    res = await fetch('/api' + url, { method, headers: { Authorization: 'Bearer ' + token }, body: fd });
  } catch (_) {
    throw new Error('Upload failed: cannot reach the server. Check your internet connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) clearSession();
  if (!res.ok) throw new Error(data.error || (res.status === 413 ? `The file is too large. The maximum size is ${maxMb} MB.` : `Upload failed (error ${res.status}). Please try again.`));
  return data;
}

async function downloadFile(id, name) {
  const res = await fetch(`/api/files/${id}/download`, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || 'Download failed.');
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// choosing a file for "Replace"
$('#modal-body').addEventListener('change', async (e) => {
  if (e.target.id === 'f-dept') return refreshReceivers();
  if (e.target.id !== 'replace-input' || !e.target.files[0]) return;
  const id = $('#modal-body').dataset.id;
  try {
    await sendFile(`/files/${replaceId}`, 'PUT', e.target.files[0]);
    toast('File replaced.');
    await openDoc(id);
  } catch (err) {
    e.target.value = '';
    toast(err.message, true);
  }
});

// buttons inside the profile
$('#modal-body').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  const id = $('#modal-body').dataset.id;
  const v = (n) => ($('#f-' + n) || {}).value || '';
  try {
    if (action === 'receipt') return await showReceipt(e.target.dataset.rid);
    if (action === 'release-slip') return await showReleaseSlip(e.target.dataset.rid);
    if (action === 'file-download') return await downloadFile(e.target.dataset.fid, e.target.dataset.name);
    if (action === 'file-replace') { replaceId = e.target.dataset.fid; $('#replace-input').click(); return; }
    if (action === 'file-delete') {
      if (!confirm('Delete this file?')) return;
      await api(`/files/${e.target.dataset.fid}`, 'DELETE');
    }
    if (action === 'upload') {
      const f = ($('#upload-input').files || [])[0];
      if (!f) throw new Error('Choose a file first.');
      await sendFile(`/documents/${id}/files`, 'POST', f);
    }
    if (action === 'route') await api(`/documents/${id}/route`, 'POST', { to_dept_id: v('dept'), receiver_id: v('receiver'), due_date: v('due'), purpose: v('purpose'), instructions: v('instr') });
    if (action === 'receive') await api(`/routing/${e.target.dataset.rid}/receive`, 'POST', { remarks: v('remarks') });
    if (action === 'return') await api(`/routing/${e.target.dataset.rid}/return`, 'POST', { remarks: v('remarks') });
    if (action === 'reject-routing') await api(`/routing/${e.target.dataset.rid}/reject`, 'POST', { remarks: v('remarks') });
    if (action === 'approve') await api(`/documents/${id}/approve`, 'POST', { decision: 'Approved', comments: v('comments') });
    if (action === 'reject') await api(`/documents/${id}/approve`, 'POST', { decision: 'Rejected', comments: v('comments') });
    if (action === 'release') {
      const to = v('to').trim();
      if (!to) throw new Error('Enter who the document is released to.');
      if (!confirm(`Release this document to "${to}"? This cannot be undone.`)) return;
      const r = await api(`/documents/${id}/release`, 'POST', { released_to: to, remarks: v('rel-remarks') });
      toast('Released.');
      await openDoc(id);
      showPage(currentPage);
      return await showReleaseSlip(r.release_id);
    }
    if (action === 'archive') {
      if (!confirm('Archive this document? This cannot be undone.')) return;
      await api(`/documents/${id}/archive`, 'POST');
    }
    toast('Saved.');
    await openDoc(id);
    showPage(currentPage);
  } catch (err) { toast(err.message, true); }
});

// ---------- senders & receivers ----------
let peopleTab = 'employees';
let people = { employees: [], senders: [], receivers: [] };
const activeText = (v) => (v ? 'Active' : 'Inactive');

async function loadPeople() {
  lookups = await api('/lookups');
  const [employees, senders, receivers] = await Promise.all([api('/employees'), api('/senders'), api('/receivers')]);
  people = { employees, senders, receivers };
  const depts = lookups.departments.filter((d) => d.is_active);
  fillSelect('#emp-dept', depts);
  fillSelect('#rcv-dept', depts);
  renderPeople();
}

function empOptions(list) {
  return list.length
    ? list.map((e) => `<option value="${e.id}">${esc(e.employee_no)} - ${esc(e.full_name)}</option>`).join('')
    : '<option value="">No employees available</option>';
}

function renderPeople() {
  ['employees', 'senders', 'receivers'].forEach((t) => { $('#tab-' + t).hidden = t !== peopleTab; });
  document.querySelectorAll('#people-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === peopleTab));
  const none = (n) => `<tr><td class="empty" colspan="${n}">Nothing here yet.</td></tr>`;
  const btn = (act, id, label) => `<button class="ghost" data-act="${act}" data-id="${id}">${label}</button>`;

  const q = $('#emp-search').value.toLowerCase();
  const emps = people.employees.filter((e) => `${e.employee_no} ${e.full_name} ${e.dept_name}`.toLowerCase().includes(q));
  $('#emp-rows').innerHTML = emps.length ? emps.map((e) => `<tr>
    <td>${esc(e.employee_no)}</td><td>${esc(e.full_name)}</td><td>${esc(e.position || '')}</td>
    <td>${esc(e.dept_name)}</td><td>${activeText(e.is_active)}</td>
    <td>${btn('emp-profile', e.id, 'Profile')}${btn('emp-edit', e.id, 'Edit')}
      ${btn('emp-toggle', e.id, e.is_active ? 'Deactivate' : 'Activate')}${btn('emp-del', e.id, 'Delete')}</td></tr>`).join('') : none(6);

  const eligible = people.employees.filter((e) => e.is_active);
  $('#snd-emp').innerHTML = empOptions(eligible.filter((e) => !e.sender_id));
  $('#rcv-emp').innerHTML = empOptions(eligible.filter((e) => !e.receiver_id));

  const rowsFor = (list, prefix) => list.length ? list.map((p) => `<tr>
    <td>${esc(p.employee_no)}</td><td>${esc(p.full_name)}</td><td>${esc(p.dept_name)}</td><td>${activeText(p.is_active)}</td>
    <td>${btn('emp-profile', p.employee_id, 'Profile')}${btn(prefix + '-toggle', p.id, p.is_active ? 'Deactivate' : 'Activate')}
      ${btn(prefix + '-del', p.id, 'Remove')}</td></tr>`).join('') : none(5);
  $('#snd-rows').innerHTML = rowsFor(people.senders, 'snd');
  $('#rcv-rows').innerHTML = rowsFor(people.receivers, 'rcv');
}

$('#people-tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) { peopleTab = e.target.dataset.tab; renderPeople(); }
});
$('#emp-search').addEventListener('input', renderPeople);

function resetEmpForm() {
  $('#emp-form').reset();
  $('#emp-id').value = '';
  $('#emp-title').textContent = 'Register employee';
  $('#emp-cancel').hidden = true;
}
$('#emp-cancel').addEventListener('click', resetEmpForm);

$('#emp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#emp-id').value;
  const body = {
    employee_no: $('#emp-no').value, full_name: $('#emp-name').value, position: $('#emp-pos').value,
    email: $('#emp-email').value, department_id: $('#emp-dept').value,
  };
  try {
    await api(id ? `/employees/${id}` : '/employees', id ? 'PUT' : 'POST', body);
    toast('Saved.');
    resetEmpForm();
    loadPeople();
  } catch (err) { toast(err.message, true); }
});

$('#snd-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/senders', 'POST', { employee_id: $('#snd-emp').value });
    toast('Sender registered.');
    loadPeople();
  } catch (err) { toast(err.message, true); }
});

$('#rcv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/receivers', 'POST', { employee_id: $('#rcv-emp').value, department_id: $('#rcv-dept').value });
    toast('Receiver registered.');
    loadPeople();
  } catch (err) { toast(err.message, true); }
});

async function showEmployee(id) {
  const { employee: e, sender, receiver } = await api('/employees/' + id);
  $('#modal-body').dataset.id = '';
  $('#modal-body').innerHTML = `
    <h2>${esc(e.full_name)}</h2>
    <dl class="meta">
      <div><dt>Employee no.</dt><dd>${esc(e.employee_no)}</dd></div>
      <div><dt>Position</dt><dd>${esc(e.position || '-')}</dd></div>
      <div><dt>Email</dt><dd>${esc(e.email || '-')}</dd></div>
      <div><dt>Department</dt><dd>${esc(e.dept_name)}</dd></div>
      <div><dt>Status</dt><dd>${activeText(e.is_active)}</dd></div>
      <div><dt>Sender</dt><dd>${sender ? 'Registered (' + activeText(sender.is_active) + ')' : 'Not registered'}</dd></div>
      <div><dt>Receiver</dt><dd>${receiver ? 'Registered for ' + esc(receiver.dept_name) + ' (' + activeText(receiver.is_active) + ')' : 'Not registered'}</dd></div>
    </dl>`;
  $('#modal').hidden = false;
}

$('#page-people').addEventListener('click', async (e) => {
  const { act, id } = e.target.dataset;
  if (!act) return;
  try {
    if (act === 'emp-profile') return await showEmployee(id);
    if (act === 'emp-edit') {
      const emp = people.employees.find((x) => x.id == id);
      $('#emp-id').value = emp.id;
      $('#emp-no').value = emp.employee_no;
      $('#emp-name').value = emp.full_name;
      $('#emp-pos').value = emp.position || '';
      $('#emp-email').value = emp.email || '';
      $('#emp-dept').value = emp.department_id;
      $('#emp-title').textContent = 'Edit employee';
      $('#emp-cancel').hidden = false;
      $('#emp-form').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (act === 'emp-toggle') await api(`/employees/${id}/toggle`, 'PUT');
    if (act === 'emp-del') { if (!confirm('Delete this employee?')) return; await api(`/employees/${id}`, 'DELETE'); }
    if (act === 'snd-toggle') await api(`/senders/${id}/toggle`, 'PUT');
    if (act === 'snd-del') { if (!confirm('Remove this sender?')) return; await api(`/senders/${id}`, 'DELETE'); }
    if (act === 'rcv-toggle') await api(`/receivers/${id}/toggle`, 'PUT');
    if (act === 'rcv-del') { if (!confirm('Remove this receiver?')) return; await api(`/receivers/${id}`, 'DELETE'); }
    loadPeople();
  } catch (err) { toast(err.message, true); }
});

// ---------- user accounts ----------
const ROLE_LABELS = { admin: 'Admin', clerk: 'Clerk', sender: 'Sender', receiver: 'Receiver', approver: 'Approver', office_staff: 'Office Staff' };
let usersList = [];

async function loadUsers() {
  lookups = await api('/lookups');
  usersList = await api('/users');
  $('#usr-role').innerHTML = Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  fillSelect('#usr-dept', lookups.departments.filter((d) => d.is_active));
  $('#usr-level').innerHTML = lookups.levels.map((l) => `<option value="${l.id}">Level ${l.level_no} - ${esc(l.name)}</option>`).join('');
  toggleLevelField();
  renderUsers();
}

function renderUsers() {
  const q = $('#usr-search').value.toLowerCase();
  const list = usersList.filter((u) => `${u.full_name} ${u.username} ${u.role} ${u.dept_name}`.toLowerCase().includes(q));
  const btn = (act, id, label) => `<button class="ghost" data-act="${act}" data-id="${id}">${label}</button>`;
  $('#usr-rows').innerHTML = list.length ? list.map((u) => `<tr>
    <td>${esc(u.full_name)}</td><td>${esc(u.username)}</td><td>${ROLE_LABELS[u.role] || esc(u.role)}</td>
    <td>${u.role === 'approver' ? esc(u.level_name || 'Not set') : '-'}</td>
    <td>${esc(u.dept_name)}</td>
    <td>${u.is_active ? 'Active' : 'Inactive'}${u.locked ? ' <span class="badge Rejected">Locked</span>' : ''}${u.reset_requested ? ' <span class="badge Pending">Reset requested</span>' : ''}</td>
    <td>${btn('usr-edit', u.id, 'Edit')}${u.locked ? btn('usr-unlock', u.id, 'Unlock') : ''}${btn('usr-pw', u.id, 'Reset password')}
      ${btn('usr-toggle', u.id, u.is_active ? 'Deactivate' : 'Activate')}${btn('usr-del', u.id, 'Delete')}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="7">No users found.</td></tr>';
}
$('#usr-search').addEventListener('input', renderUsers);

function resetUsrForm() {
  $('#usr-form').reset();
  $('#usr-id').value = '';
  $('#usr-title').textContent = 'Create account';
  $('#usr-username').disabled = false;
  $('#usr-pw-label').hidden = false;
  $('#usr-cancel').hidden = true;
  toggleLevelField();
}
function toggleLevelField() {
  $('#usr-level-label').hidden = $('#usr-role').value !== 'approver';
}
$('#usr-role').addEventListener('change', toggleLevelField);
$('#usr-cancel').addEventListener('click', resetUsrForm);

$('#usr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#usr-id').value;
  const body = { full_name: $('#usr-name').value, role: $('#usr-role').value, department_id: $('#usr-dept').value,
    approval_level_id: $('#usr-role').value === 'approver' ? $('#usr-level').value : null };
  try {
    if (id) {
      await api(`/users/${id}`, 'PUT', body);
    } else {
      await api('/users', 'POST', { ...body, username: $('#usr-username').value, password: $('#usr-pw').value });
    }
    toast('Saved.');
    resetUsrForm();
    loadUsers();
  } catch (err) { toast(err.message, true); }
});

$('#page-users').addEventListener('click', async (e) => {
  const { act, id } = e.target.dataset;
  if (!act) return;
  const u = usersList.find((x) => x.id == id);
  try {
    if (act === 'usr-edit') {
      $('#usr-id').value = u.id;
      $('#usr-name').value = u.full_name;
      $('#usr-username').value = u.username;
      $('#usr-username').disabled = true;
      $('#usr-pw-label').hidden = true;
      $('#usr-role').value = u.role;
      $('#usr-dept').value = u.department_id;
      if (u.approval_level_id) $('#usr-level').value = u.approval_level_id;
      toggleLevelField();
      $('#usr-title').textContent = 'Edit account';
      $('#usr-cancel').hidden = false;
      $('#usr-form').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (act === 'usr-pw') {
      const pw = prompt(`Temporary password for ${u.username} (min. 8 characters). They must choose their own password when they log in:`);
      if (!pw) return;
      await api(`/users/${id}/password`, 'PUT', { new_password: pw });
      toast('Temporary password set. Give it to the user.');
      loadUsers();
      return;
    }
    if (act === 'usr-unlock') {
      await api(`/users/${id}/unlock`, 'PUT');
      toast('Account unlocked.');
    }
    if (act === 'usr-toggle') await api(`/users/${id}/toggle`, 'PUT');
    if (act === 'usr-del') { if (!confirm(`Delete ${u.username}?`)) return; await api(`/users/${id}`, 'DELETE'); }
    loadUsers();
  } catch (err) { toast(err.message, true); }
});

// ---------- audit trail (WP26) ----------
let auditPage = 1;
function auditQuery(page, exportAll) {
  const p = new URLSearchParams({ q: $('#au-q').value, action: $('#au-action').value, from: $('#au-from').value, to: $('#au-to').value, page });
  if (exportAll) p.set('export', '1');
  return '/audit?' + p.toString();
}
async function loadAudit(page = 1) {
  const d = await api(auditQuery(page));
  auditPage = d.page;
  const keep = $('#au-action').value;
  $('#au-action').innerHTML = '<option value="">All actions</option>' + d.actions.map((a) => `<option>${esc(a)}</option>`).join('');
  $('#au-action').value = keep;
  $('#au-rows').innerHTML = d.rows.length ? d.rows.map((r) => `<tr${r.document_id ? ` class="click" data-id="${r.document_id}"` : ''}>
      <td>${fmt(r.created_at)}</td><td>${esc(r.user_name || '-')}${r.username && r.user_name !== r.username ? ` <span class="muted">(${esc(r.username)})</span>` : ''}</td>
      <td>${esc(r.action)}</td><td>${esc(r.doc_number || '-')}</td><td>${esc(r.details || '')}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="5">No audit entries found.</td></tr>';
  $('#au-sum').textContent = `${d.total} entr${d.total === 1 ? 'y' : 'ies'} found`;
  $('#au-page').textContent = `Page ${d.page} of ${d.pages}`;
  $('#au-prev').disabled = d.page <= 1;
  $('#au-next').disabled = d.page >= d.pages;
}
$('#au-apply').addEventListener('click', () => loadAudit(1).catch((err) => toast(err.message, true)));
$('#au-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAudit(1).catch((err) => toast(err.message, true)); });
$('#au-prev').addEventListener('click', () => loadAudit(auditPage - 1).catch((err) => toast(err.message, true)));
$('#au-next').addEventListener('click', () => loadAudit(auditPage + 1).catch((err) => toast(err.message, true)));
$('#au-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDoc(tr.dataset.id);
});
$('#au-csv').addEventListener('click', async () => {
  try {
    const d = await api(auditQuery(1, true));
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Date and time', 'User', 'Username', 'Action', 'Document', 'Details'].map(cell).join(',')]
      .concat(d.rows.map((r) => [fmt(r.created_at), r.user_name, r.username, r.action, r.doc_number, r.details].map(cell).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    if (d.total > d.rows.length) toast(`Exported the newest ${d.rows.length} of ${d.total} entries. Narrow the dates to export the rest.`);
  } catch (err) { toast(err.message, true); }
});

// ---------- approval levels (WP15) ----------
let levelsList = [];
async function loadLevels() {
  levelsList = await api('/approval-levels');
  $('#lvl-rows').innerHTML = levelsList.map((l) => `<tr>
    <td>Level ${l.level_no}</td><td>${esc(l.name)}</td>
    <td class="${l.is_active && !l.approvers ? 'late' : ''}">${l.approvers}${l.is_active && !l.approvers ? ' (none yet: the admin must approve on behalf)' : ''}</td>
    <td>${l.is_active ? 'Active' : 'Skipped'}</td>
    <td><button class="ghost" data-act="lvl-rename" data-id="${l.id}">Rename</button>
        <button class="ghost" data-act="lvl-toggle" data-id="${l.id}">${l.is_active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('');
}
$('#page-levels').addEventListener('click', async (e) => {
  const { act, id } = e.target.dataset;
  if (!act) return;
  const l = levelsList.find((x) => x.id == id);
  try {
    if (act === 'lvl-rename') {
      const name = prompt(`New name for Level ${l.level_no}:`, l.name);
      if (!name) return;
      await api(`/approval-levels/${id}`, 'PUT', { name });
    }
    if (act === 'lvl-toggle') await api(`/approval-levels/${id}/toggle`, 'PUT');
    toast('Saved.');
    loadLevels();
  } catch (err) { toast(err.message, true); }
});

// ---------- change my own password ----------
function passwordFormHtml(title, intro, curLabel) {
  return `<h2>${title}</h2>${intro ? `<p class="muted">${intro}</p>` : ''}
    <form id="pw-form" class="form">
      <label>${curLabel} <input id="pw-cur" type="password" required></label>
      <label>New password (min. 8 characters) <input id="pw-new" type="password" required minlength="8"></label>
      <label>Confirm new password <input id="pw-new2" type="password" required></label>
      <button type="submit">Save password</button>
    </form>`;
}
$('#change-pw').addEventListener('click', () => {
  $('#modal-body').dataset.id = '';
  $('#modal-body').innerHTML = passwordFormHtml('Change password', '', 'Current password');
  $('#modal').hidden = false;
});

// WP25: shown right after login when the admin gave this user a temporary password
function showForcedPasswordChange() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#who').textContent = `${user.name} (${user.role}, ${user.dept_name})`;
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = true));
  showChrome(false);
  $('#modal-body').dataset.id = '';
  $('#modal-body').innerHTML = passwordFormHtml('Choose your new password',
    'The administrator gave you a temporary password. Choose your own password to continue.', 'Temporary password')
    + '<p class="login-links"><a href="#" id="pw-logout">Log out instead</a></p>';
  $('#modal').hidden = false;
}
$('#modal-body').addEventListener('click', (e) => {
  if (e.target.id !== 'pw-logout') return;
  e.preventDefault();
  $('#logout').click(); // the full-screen box covers the header, so the Log out button is reached from here
});

$('#modal-body').addEventListener('submit', async (e) => {
  if (e.target.id !== 'pw-form') return;
  e.preventDefault();
  if ($('#pw-new').value !== $('#pw-new2').value) return toast('The new passwords do not match.', true);
  try {
    await api('/me/password', 'POST', { current_password: $('#pw-cur').value, new_password: $('#pw-new').value });
    $('#modal').hidden = true;
    toast('Password changed.');
    if (user.must_change) {
      user.must_change = false;
      localStorage.setItem('user', JSON.stringify(user));
      startApp();
    }
  } catch (err) { toast(err.message, true); }
});

// ---------- register page (refresh lists each time) ----------
async function loadRegister() {
  lookups = await api('/lookups');
  fillSelect('#r-type', lookups.types);
  fillSelect('#r-dept', lookups.departments.filter((d) => d.is_active));
  fillSelect('#r-sender', lookups.senders);
}

// ---------- document types ----------
let docTypes = [];

async function loadDocTypes() {
  docTypes = await api('/document-types');
  renderDocTypes();
}

function renderDocTypes() {
  const q = $('#dt-search').value.toLowerCase();
  const list = docTypes.filter((t) => t.name.toLowerCase().includes(q));
  $('#dt-rows').innerHTML = list.length ? list.map((t) => `<tr>
    <td>${esc(t.name)}</td><td>${t.doc_count}</td>
    <td><button class="ghost" data-act="dt-edit" data-id="${t.id}">Edit</button>
      <button class="ghost" data-act="dt-del" data-id="${t.id}">Delete</button></td></tr>`).join('')
    : '<tr><td class="empty" colspan="3">No document types found.</td></tr>';
}
$('#dt-search').addEventListener('input', renderDocTypes);

function resetDtForm() {
  $('#dt-form').reset();
  $('#dt-id').value = '';
  $('#dt-title').textContent = 'Add document type';
  $('#dt-cancel').hidden = true;
}
$('#dt-cancel').addEventListener('click', resetDtForm);

$('#dt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#dt-id').value;
  try {
    await api(id ? `/document-types/${id}` : '/document-types', id ? 'PUT' : 'POST', { name: $('#dt-name').value });
    toast('Saved.');
    resetDtForm();
    loadDocTypes();
  } catch (err) { toast(err.message, true); }
});

$('#dt-rows').addEventListener('click', async (e) => {
  const { act, id } = e.target.dataset;
  if (!act) return;
  const t = docTypes.find((x) => x.id == id);
  try {
    if (act === 'dt-edit') {
      $('#dt-id').value = t.id;
      $('#dt-name').value = t.name;
      $('#dt-title').textContent = 'Edit document type';
      $('#dt-cancel').hidden = false;
      $('#dt-form').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (act === 'dt-del') {
      if (!confirm(`Delete "${t.name}"?`)) return;
      await api(`/document-types/${id}`, 'DELETE');
      toast('Deleted.');
      loadDocTypes();
    }
  } catch (err) { toast(err.message, true); }
});

// ---------- inbox ----------
async function loadInbox() {
  const q = encodeURIComponent($('#inbox-search').value);
  const s = encodeURIComponent($('#inbox-status').value);
  const o = encodeURIComponent($('#inbox-sort').value);
  const rows = await api(`/inbox?q=${q}&status=${s}&sort=${o}`);
  $('#inbox-note').textContent = user.role === 'admin'
    ? 'Showing documents routed to every department.'
    : `Documents routed to ${user.dept_name}.`;
  $('#inbox-rows').innerHTML = rows.length
    ? rows.map((r) => `<tr class="click" data-id="${r.doc_id}">
        <td>${esc(r.doc_number)}</td><td>${esc(r.title)}</td><td>${esc(r.type_name)}</td><td>${esc(r.from_name)}</td>
        <td>${esc(r.receiver_name || '-')}</td>
        <td class="${r.overdue ? 'late' : ''}">${esc(r.due_date || '-')}${r.overdue ? ' (overdue)' : ''}</td>
        <td>${fmt(r.routed_at)}</td><td>${badge(r.status)}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="8">Your inbox is empty.</td></tr>';
}
$('#inbox-search').addEventListener('input', loadInbox);
$('#inbox-status').addEventListener('change', loadInbox);
$('#inbox-sort').addEventListener('change', loadInbox);
$('#inbox-rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDoc(tr.dataset.id);
});

// ---------- init ----------
if (token && user) startApp();

// ---------- acknowledgment receipt (WP14) ----------
async function showReceipt(routingId) {
  const r = await api(`/routing/${routingId}/acknowledgment`);
  const row = (label, value) => `<tr><th>${label}</th><td>${esc(value || '-')}</td></tr>`;
  $('#receipt-body').innerHTML = `
    <h2>Acknowledgment Receipt</h2>
    <p class="ack-no">${esc(r.ack_no)}</p>
    <table class="receipt-table"><tbody>
      ${row('Document number', r.doc_number)}
      ${row('Title', r.title)}
      ${row('Document type', r.type_name)}
      ${row('From', r.from_name)}
      ${row('Received by (department)', r.to_name)}
      ${row('Assigned receiver', r.receiver_name)}
      ${row('Routed by', r.routed_by_name)}
      ${row('Date routed', fmt(r.routed_at))}
      ${row('Received by (user)', r.received_by_name + (r.received_by_dept ? ' (' + r.received_by_dept + ')' : ''))}
      ${row('Date and time received', fmt(r.received_at))}
      ${row('Remarks', r.remarks)}
    </tbody></table>
    <p class="sign-line">Signature over printed name</p>`;
  $('#receipt-modal').hidden = false;
}
// WP19: release confirmation slip (reuses the printable receipt window)
async function showReleaseSlip(releaseId) {
  const r = await api(`/releases/${releaseId}/confirmation`);
  const row = (label, value) => `<tr><th>${label}</th><td>${esc(value || '-')}</td></tr>`;
  $('#receipt-body').innerHTML = `
    <h2>Release Confirmation</h2>
    <p class="ack-no">${esc(r.release_no)}</p>
    <table class="receipt-table"><tbody>
      ${row('Document number', r.doc_number)}
      ${row('Title', r.title)}
      ${row('Document type', r.type_name)}
      ${row('Origin department', r.origin_name)}
      ${row('Approved on', fmt(r.approved_at))}
      ${row('Released to', r.released_to)}
      ${row('Released by', r.released_by_name + ' (' + r.released_by_dept + ')')}
      ${row('Date and time released', fmt(r.released_at))}
      ${row('Remarks', r.remarks)}
    </tbody></table>
    <p class="sign-line">Signature of receiving person over printed name</p>`;
  $('#receipt-modal').hidden = false;
}

// WP19: release history of all documents
async function loadReleases() {
  const rows = await api(`/releases?q=${encodeURIComponent($('#rel-search').value)}`);
  $('#rel-rows').innerHTML = rows.length
    ? rows.map((r) => `<tr class="click" data-id="${r.document_id}">
        <td>${esc(r.release_no)}</td><td>${esc(r.doc_number)}</td><td>${esc(r.title)}</td>
        <td>${esc(r.released_to)}</td><td>${esc(r.released_by_name)}</td><td>${fmt(r.released_at)}</td>
        <td>${esc(r.remarks || '')}</td>
        <td><button class="ghost" data-slip="${r.id}">Confirmation</button></td></tr>`).join('')
    : '<tr><td class="empty" colspan="8">No releases yet.</td></tr>';
}
$('#rel-search').addEventListener('input', loadReleases);
$('#rel-rows').addEventListener('click', (e) => {
  if (e.target.dataset.slip) return showReleaseSlip(e.target.dataset.slip).catch((err) => toast(err.message, true));
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDoc(tr.dataset.id);
});

// WP22: notifications (the bell in the header)
async function loadBell() {
  if (!token) return;
  try {
    const n = await api('/notifications');
    $('#bell-count').textContent = n.unread;
    $('#bell-count').hidden = !n.unread;
    $('#bell-list').innerHTML = n.rows.length
      ? n.rows.map((r) => `<li class="${r.is_read ? '' : 'unread'}" data-nid="${r.id}" data-doc="${r.document_id || ''}">
          <span>${esc(r.message)}</span><small>${fmt(r.created_at)}</small></li>`).join('')
      : '<li class="empty">No notifications yet.</li>';
  } catch (_) { /* try again at the next round */ }
}
$('#bell').addEventListener('click', () => { $('#bell-panel').hidden = !$('#bell-panel').hidden; });
$('#bell-readall').addEventListener('click', async () => {
  try { await api('/notifications/read-all', 'PUT'); loadBell(); } catch (err) { toast(err.message, true); }
});
$('#bell-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-nid]');
  if (!li) return;
  try {
    await api(`/notifications/${li.dataset.nid}/read`, 'PUT');
    $('#bell-panel').hidden = true;
    loadBell();
    if (li.dataset.doc) openDoc(li.dataset.doc);
    else if (li.textContent.trim().startsWith('Password reset requested')) showPage('users');
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#bell-panel') && !e.target.closest('#bell')) $('#bell-panel').hidden = true;
});

// WP20: real-time tracking. Every 10 seconds the open document and the current list refresh by themselves.
const LIVE_MS = 10000;
const docSignature = (d) => [d.doc.status, d.history.length, d.files.length, d.routing.length, d.approvals.length, d.releases.length].join('|');
function modalBusy() { // do not refresh while the user is typing or has chosen a file
  return [...document.querySelectorAll('#modal-body input, #modal-body textarea')]
    .some((el) => (el.type === 'file' ? el.files.length : el.value));
}
async function liveRefresh() {
  if (document.hidden || !token || (user && user.must_change)) return;
  loadBell();
  if (!$('#receipt-modal').hidden) return;
  try {
    if (!$('#modal').hidden) {
      const id = $('#modal-body').dataset.id;
      if (!id || modalBusy()) return;
      if (docSignature(await api('/documents/' + id)) !== $('#modal-body').dataset.sig) await openDoc(id);
    } else if (['dashboard', 'documents', 'inbox', 'overdue', 'releases'].includes(currentPage)) {
      showPage(currentPage);
    }
  } catch (_) { /* try again at the next round */ }
}
setInterval(liveRefresh, LIVE_MS);

$('#receipt-print').addEventListener('click', () => window.print());
$('#receipt-close').addEventListener('click', () => { $('#receipt-modal').hidden = true; });
