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
  fillSelect('#r-sender', lookups.senders);
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
  ({ dashboard: loadDashboard, documents: loadDocuments, overdue: loadOverdue, departments: loadDepartments, people: loadPeople, users: loadUsers, register: loadRegister, doctypes: loadDocTypes, inbox: loadInbox }[page] || (() => {}))();
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
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

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
  const { doc, routing, approvals, releases, files, history } = data;
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

  const FILE_ACCEPT = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.gif,.webp';
  const canFiles = ['admin', 'clerk', 'sender'].includes(user.role) && doc.status !== 'Released';
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
        <label>Attach a file (PDF, DOCX, XLSX or image, max 5 MB)
          <input type="file" id="upload-input" accept="${FILE_ACCEPT}"></label>
        <button data-action="upload">Upload</button>
        <input type="file" id="replace-input" accept="${FILE_ACCEPT}" hidden>
      </div>` : ''}`;

  const routingRows = routing.length
    ? routing.map((r) => `<tr><td>${esc(r.from_name)} &rarr; ${esc(r.to_name)}</td><td>${esc(r.purpose || '')}</td>
        <td>${esc(r.receiver_name || '-')}</td><td>${esc(r.due_date || '-')}</td>
        <td>${badge(r.status)}</td><td>${r.received_by_name ? esc(r.received_by_name) + '<br><small>' + fmt(r.received_at) + '</small>' : ''}</td>
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
    ${actions}
    ${filesHtml}
    <h3 style="margin-top:1rem">Routing</h3>
    <table><thead><tr><th>Route</th><th>Purpose</th><th>Assigned to</th><th>Due</th><th>Status</th><th>Handled by</th><th>Remarks</th></tr></thead>
      <tbody>${routingRows}</tbody></table>
    ${approvals.length ? `<h3 style="margin-top:1rem">Approvals</h3><table><thead><tr><th>Approver</th><th>Decision</th><th>Comments</th><th>Date</th></tr></thead><tbody>
      ${approvals.map((a) => `<tr><td>${esc(a.approver_name)}</td><td>${badge(a.decision)}</td><td>${esc(a.comments || '')}</td><td>${fmt(a.decided_at)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${releases.length ? `<h3 style="margin-top:1rem">Release</h3><table><thead><tr><th>Released to</th><th>By</th><th>Remarks</th><th>Date</th></tr></thead><tbody>
      ${releases.map((r) => `<tr><td>${esc(r.released_to)}</td><td>${esc(r.released_by_name)}</td><td>${esc(r.remarks || '')}</td><td>${fmt(r.released_at)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h3 style="margin-top:1rem">Tracking history</h3>
    <ul class="timeline">${history.map((h) => `<li><b>${esc(h.action)}</b> &ndash; ${esc(h.details || '')}
      <small>${esc(h.user_name)}, ${fmt(h.created_at)}</small></li>`).join('')}</ul>`;
  $('#modal').hidden = false;
  refreshReceivers();
}

// ---------- file helpers ----------
let replaceId = null;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

async function sendFile(url, method, file) {
  if (file.size > 5 * 1024 * 1024) throw new Error('File is too large. The maximum size is 5 MB.');
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api' + url, { method, headers: { Authorization: 'Bearer ' + token }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) clearSession();
  if (!res.ok) throw new Error(data.error || 'Upload failed.');
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
    if (action === 'release') await api(`/documents/${id}/release`, 'POST', { released_to: v('to'), remarks: v('rel-remarks') });
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
  renderUsers();
}

function renderUsers() {
  const q = $('#usr-search').value.toLowerCase();
  const list = usersList.filter((u) => `${u.full_name} ${u.username} ${u.role} ${u.dept_name}`.toLowerCase().includes(q));
  const btn = (act, id, label) => `<button class="ghost" data-act="${act}" data-id="${id}">${label}</button>`;
  $('#usr-rows').innerHTML = list.length ? list.map((u) => `<tr>
    <td>${esc(u.full_name)}</td><td>${esc(u.username)}</td><td>${ROLE_LABELS[u.role] || esc(u.role)}</td>
    <td>${esc(u.dept_name)}</td><td>${u.is_active ? 'Active' : 'Inactive'}</td>
    <td>${btn('usr-edit', u.id, 'Edit')}${btn('usr-pw', u.id, 'Reset password')}
      ${btn('usr-toggle', u.id, u.is_active ? 'Deactivate' : 'Activate')}${btn('usr-del', u.id, 'Delete')}</td></tr>`).join('')
    : '<tr><td class="empty" colspan="6">No users found.</td></tr>';
}
$('#usr-search').addEventListener('input', renderUsers);

function resetUsrForm() {
  $('#usr-form').reset();
  $('#usr-id').value = '';
  $('#usr-title').textContent = 'Create account';
  $('#usr-username').disabled = false;
  $('#usr-pw-label').hidden = false;
  $('#usr-cancel').hidden = true;
}
$('#usr-cancel').addEventListener('click', resetUsrForm);

$('#usr-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#usr-id').value;
  const body = { full_name: $('#usr-name').value, role: $('#usr-role').value, department_id: $('#usr-dept').value };
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
      $('#usr-title').textContent = 'Edit account';
      $('#usr-cancel').hidden = false;
      $('#usr-form').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (act === 'usr-pw') {
      const pw = prompt(`New password for ${u.username} (min. 8 characters):`);
      if (!pw) return;
      await api(`/users/${id}/password`, 'PUT', { new_password: pw });
      toast('Password reset.');
      return;
    }
    if (act === 'usr-toggle') await api(`/users/${id}/toggle`, 'PUT');
    if (act === 'usr-del') { if (!confirm(`Delete ${u.username}?`)) return; await api(`/users/${id}`, 'DELETE'); }
    loadUsers();
  } catch (err) { toast(err.message, true); }
});

// ---------- change my own password ----------
$('#change-pw').addEventListener('click', () => {
  $('#modal-body').dataset.id = '';
  $('#modal-body').innerHTML = `<h2>Change password</h2>
    <form id="pw-form" class="form">
      <label>Current password <input id="pw-cur" type="password" required></label>
      <label>New password (min. 8 characters) <input id="pw-new" type="password" required minlength="8"></label>
      <label>Confirm new password <input id="pw-new2" type="password" required></label>
      <button type="submit">Save password</button>
    </form>`;
  $('#modal').hidden = false;
});
$('#modal-body').addEventListener('submit', async (e) => {
  if (e.target.id !== 'pw-form') return;
  e.preventDefault();
  if ($('#pw-new').value !== $('#pw-new2').value) return toast('The new passwords do not match.', true);
  try {
    await api('/me/password', 'POST', { current_password: $('#pw-cur').value, new_password: $('#pw-new').value });
    $('#modal').hidden = true;
    toast('Password changed.');
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
