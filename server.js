require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const OVERDUE_DAYS = 3; // a routed document not received after this many days is overdue
const MAX_FAILED_LOGINS = 5; // WP25: this many wrong passwords in a row lock the account
const LOCK_MINUTES = 15;     // ...for this many minutes (the admin can unlock it earlier)

const app = express();
app.disable('x-powered-by');
// WP34 hardening: browser security headers. (Inline style="" is used by the screens, so styles allow it; scripts do not.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.VERCEL) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const isVercel = !!process.env.VERCEL;
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dts_db',
  waitForConnections: true,
  connectionLimit: isVercel ? 3 : 10,
  // cloud databases (Aiven, TiDB, ...) need an encrypted connection: set DB_SSL=true
  ssl: process.env.DB_SSL === 'true'
    ? (process.env.DB_CA ? { ca: process.env.DB_CA } : { rejectUnauthorized: false })
    : undefined,
});

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
// WP30: clear messages. The full technical error is printed in the terminal. People only see it on screen
// when running locally on your own computer; online (Vercel) they only get a short, safe message.
const SHOW_ERROR_DETAILS = !isVercel && process.env.NODE_ENV !== 'production';
const SAFE_500 = 'Something went wrong on the server. Please try again. If it keeps happening, tell the administrator.';
// database errors that mean "the person typed something wrong", not "the server is broken"
function friendlyDbError(e) {
  if (!e || !e.code) return null;
  if (e.code === 'ER_DATA_TOO_LONG') return 'One of the values is too long. Please shorten it and try again.';
  if (e.code === 'ER_DUP_ENTRY') return 'That record already exists.';
  if (e.code === 'ER_NO_REFERENCED_ROW_2') return 'One of the selected items no longer exists. Refresh the page and try again.';
  if (e.code === 'ER_ROW_IS_REFERENCED_2') return 'This record is in use and cannot be removed.';
  if (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT') return 'The system was busy. Please try again.';
  return null;
}
const serverError = (e) => 'Server error: ' + e.message;
function sendError(res, e) {
  if (e.status) return res.status(e.status).json({ error: e.message });
  const friendly = friendlyDbError(e);
  if (friendly) return res.status(400).json({ error: friendly });
  console.error(e);
  res.status(500).json({ error: SHOW_ERROR_DETAILS ? serverError(e) : SAFE_500 });
}
const h = (fn) => (req, res) => fn(req, res).catch((e) => sendError(res, e));

// WP29: input checks (text only, trimmed, not longer than the database column)
const text = (v) => {
  if (v !== null && v !== undefined && typeof v === 'object') throw new HttpError(400, 'Invalid input. Please type plain text.');
  return String(v ?? '').trim();
};
function maxLen(value, max, label) {
  if (text(value).length > max) throw new HttpError(400, `${label} must be ${max} characters or less.`);
}

async function tx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// WP26: audit trail. Writes one row in audit_logs. It never stops the real action: if the audit row
// cannot be saved, the problem is printed in the terminal and the action still goes through.
// who = { id, username } (id can be empty for a failed login with an unknown username)
async function audit(who, action, details, docId = null, conn = pool) {
  try {
    const id = who && who.id ? who.id : null;
    const typed = who && who.username ? String(who.username).slice(0, 50) : null;
    await conn.query(
      `INSERT INTO audit_logs (user_id, username, action, document_id, details)
       VALUES (?, COALESCE(?, (SELECT username FROM users WHERE id=?)), ?, ?, ?)`,
      [id, typed, id, String(action).slice(0, 50), docId, details == null ? null : String(details).slice(0, 300)]);
  } catch (e) {
    console.error('Audit trail could not be saved:', e.message);
  }
}

// every action writes a tracking record (and, for WP26, an audit trail row)
const track = async (conn, docId, action, details, userId) => {
  await conn.query(
    'INSERT INTO tracking_history (document_id, action, details, user_id) VALUES (?,?,?,?)',
    [docId, action, details, userId]
  );
  await audit({ id: userId }, action, details, docId, conn);
};

async function getDoc(conn, id) {
  const [[doc]] = await conn.query('SELECT * FROM documents WHERE id=? FOR UPDATE', [id]);
  if (!doc) throw new HttpError(404, 'Document not found.');
  return doc;
}

// ---------- WP22: notifications ----------
async function idsOf(conn, sql, params = []) {
  const [rows] = await conn.query(sql, params);
  return rows.map((r) => r.id);
}
// one notification per person (the person who did the action is never notified)
async function notify(conn, userIds, docId, message, exceptUserId) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== exceptUserId);
  for (const id of ids)
    await conn.query('INSERT INTO notifications (user_id, document_id, message) VALUES (?,?,?)', [id, docId, message.slice(0, 250)]);
}
const clerkIds = (conn) => idsOf(conn, "SELECT id FROM users WHERE role='clerk' AND is_active=1");
// the approvers of an approval level (the admin if that level has nobody yet)
async function approverIds(conn, level) {
  const ids = await idsOf(conn, "SELECT id FROM users WHERE role='approver' AND is_active=1 AND approval_level_id=?", [level.id]);
  return ids.length ? ids : idsOf(conn, "SELECT id FROM users WHERE role='admin' AND is_active=1");
}

// ---------- login sessions (kept in the database so they survive on Vercel) ----------
const SESSION_DAYS = 7;
const tokenOf = (req) => (req.headers.authorization || '').replace('Bearer ', '');

function auth(roles = []) {
  return async (req, res, next) => {
    try {
      const [[row]] = await pool.query(
        `SELECT user_json FROM sessions WHERE token=? AND created_at > NOW() - INTERVAL ${SESSION_DAYS} DAY`,
        [tokenOf(req)]);
      if (!row) return res.status(401).json({ error: 'Please log in.' });
      const user = JSON.parse(row.user_json);
      // WP25: after an admin reset, the user may only change the password (or log out) until it is done
      if (user.must_change) {
        const url = req.originalUrl.split('?')[0];
        if (!(req.method === 'POST' && (url === '/api/me/password' || url === '/api/logout')))
          return res.status(403).json({ error: 'You must change your password first.', must_change: true });
      }
      if (roles.length && !roles.includes(user.role))
        return res.status(403).json({ error: 'You are not allowed to do this.' });
      req.user = user;
      next();
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: SHOW_ERROR_DETAILS ? serverError(e) : SAFE_500 });
    }
  };
}

// creates the extra tables/columns this version needs (safe to run many times)
async function ensureSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    user_json VARCHAR(500) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_user (user_id)
  )`);
  const [[{ c }]] = await pool.query(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'files' AND COLUMN_NAME = 'file_data'`);
  if (!Number(c)) await pool.query('ALTER TABLE files ADD COLUMN file_data LONGBLOB NULL');

  // WP15-17: approval levels (Department Head > Dean > Vice President > President)
  await pool.query(`CREATE TABLE IF NOT EXISTS approval_levels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    level_no TINYINT NOT NULL UNIQUE,
    name VARCHAR(60) NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1
  )`);
  const [[{ n: levelCount }]] = await pool.query('SELECT COUNT(*) n FROM approval_levels');
  if (!Number(levelCount))
    await pool.query(`INSERT INTO approval_levels (level_no, name)
      VALUES (1,'Department Head'),(2,'Dean'),(3,'Vice President'),(4,'President')`);
  await addColumn('users', 'approval_level_id',
    'INT NULL, ADD CONSTRAINT fk_users_level FOREIGN KEY (approval_level_id) REFERENCES approval_levels(id)');
  await addColumn('approvals', 'level_id',
    'INT NULL, ADD CONSTRAINT fk_approvals_level FOREIGN KEY (level_id) REFERENCES approval_levels(id)');
  await addColumn('approvals', 'routing_id',
    'INT NULL, ADD CONSTRAINT fk_approvals_routing FOREIGN KEY (routing_id) REFERENCES routing(id)');

  // WP25: failed-login lock, password reset requests, forced password change
  await addColumn('users', 'failed_attempts', 'INT NOT NULL DEFAULT 0');
  await addColumn('users', 'locked_until', 'DATETIME NULL');
  await addColumn('users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('users', 'reset_requested', 'TINYINT(1) NOT NULL DEFAULT 0');
}

// the original "dean" test account becomes the Level 2 approver (runs after the default users exist)
async function linkDeanToLevel() {
  await pool.query(`UPDATE users SET approval_level_id = (SELECT id FROM approval_levels WHERE level_no = 2)
    WHERE username = 'dean' AND role = 'approver' AND approval_level_id IS NULL`);
}

// WP20: the Archived status (the statuses list already has it, the documents.status column did not)
async function ensureArchivedStatus() {
  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE ct FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'documents' AND COLUMN_NAME = 'status'`);
  if (col && !/Archived/.test(col.ct))
    await pool.query(`ALTER TABLE documents MODIFY status
      ENUM('Registered','Routed','Received','Returned','Approved','Rejected','Released','Archived')
      NOT NULL DEFAULT 'Registered'`);
}

async function addColumn(table, column, definition) {
  const [[{ c }]] = await pool.query(
    `SELECT COUNT(*) c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  if (!Number(c)) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// WP26: the audit_logs table must accept rows with no user (failed login with an unknown username)
// and must keep the username, so the record stays readable even if the account is deleted later.
async function ensureAuditTable() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(50) NULL,
      action VARCHAR(50) NOT NULL,
      document_id INT NULL,
      details VARCHAR(300),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_created (created_at),
      FOREIGN KEY (document_id) REFERENCES documents(id)
    )`);
    await addColumn('audit_logs', 'username', 'VARCHAR(50) NULL');
    const [fks] = await pool.query(
      `SELECT CONSTRAINT_NAME fk FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'user_id'
         AND REFERENCED_TABLE_NAME IS NOT NULL`);
    for (const f of fks) await pool.query(`ALTER TABLE audit_logs DROP FOREIGN KEY \`${f.fk}\``);
    const [[col]] = await pool.query(
      `SELECT IS_NULLABLE nul FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs' AND COLUMN_NAME = 'user_id'`);
    if (col && col.nul === 'NO') await pool.query('ALTER TABLE audit_logs MODIFY user_id INT NULL');
  } catch (e) {
    console.error('Audit table setup failed (the audit trail may be incomplete):', e.message);
  }
}

let readyPromise;
function ready() {
  if (!readyPromise)
    readyPromise = ensureSchema().then(ensureAuditTable).then(ensureArchivedStatus).then(seedUsers).then(linkDeanToLevel).catch((e) => { readyPromise = null; throw e; });
  return readyPromise;
}
app.use('/api', (req, res, next) =>
  ready().then(() => next()).catch((e) => {
    console.error(e);
    res.status(500).json({ error: SHOW_ERROR_DETAILS ? 'Database error: ' + e.message : 'The database is not available right now. Please try again in a moment.' });
  }));

// ---------- WP26: automatic audit rows for setup and account changes ----------
// Document actions are recorded by track(). The routes below (departments, people, accounts, types,
// approval levels) are recorded here. The name is read BEFORE the change, so a deleted item is still named.
const SQL_DEPT = 'SELECT name label, is_active active FROM departments WHERE id=?';
const SQL_EMP = "SELECT CONCAT(employee_no, ' - ', full_name) label, is_active active FROM employees WHERE id=?";
const SQL_SND = "SELECT CONCAT(e.employee_no, ' - ', e.full_name) label, s.is_active active FROM senders s JOIN employees e ON e.id = s.employee_id WHERE s.id=?";
const SQL_RCV = "SELECT CONCAT(e.employee_no, ' - ', e.full_name) label, r.is_active active FROM receivers r JOIN employees e ON e.id = r.employee_id WHERE r.id=?";
const SQL_USR = "SELECT CONCAT(full_name, ' (', username, ')') label, is_active active FROM users WHERE id=?";
const SQL_TYP = 'SELECT name label FROM document_types WHERE id=?';
const SQL_LVL = "SELECT CONCAT('Level ', level_no, ' - ', name) label, is_active active FROM approval_levels WHERE id=?";
const AUDIT_RULES = [
  // [method, path, action (or [if it was inactive, if it was active]), lookup, details(before, body)]
  ['POST', /^\/api\/departments$/, 'Department created', null, (p, b) => b.name],
  ['PUT', /^\/api\/departments\/(\d+)$/, 'Department updated', SQL_DEPT, (p, b) => `${p.label} -> ${b.name}`],
  ['PUT', /^\/api\/departments\/(\d+)\/toggle$/, ['Department activated', 'Department deactivated'], SQL_DEPT, (p) => p.label],
  ['DELETE', /^\/api\/departments\/(\d+)$/, 'Department deleted', SQL_DEPT, (p) => p.label],
  ['POST', /^\/api\/employees$/, 'Employee created', null, (p, b) => `${b.employee_no} - ${b.full_name}`],
  ['PUT', /^\/api\/employees\/(\d+)$/, 'Employee updated', SQL_EMP, (p, b) => `${p.label} -> ${b.employee_no} - ${b.full_name}`],
  ['PUT', /^\/api\/employees\/(\d+)\/toggle$/, ['Employee activated', 'Employee deactivated'], SQL_EMP, (p) => p.label],
  ['DELETE', /^\/api\/employees\/(\d+)$/, 'Employee deleted', SQL_EMP, (p) => p.label],
  ['POST', /^\/api\/senders$/, 'Sender registered', SQL_EMP, (p) => p.label],
  ['PUT', /^\/api\/senders\/(\d+)\/toggle$/, ['Sender activated', 'Sender deactivated'], SQL_SND, (p) => p.label],
  ['DELETE', /^\/api\/senders\/(\d+)$/, 'Sender removed', SQL_SND, (p) => p.label],
  ['POST', /^\/api\/receivers$/, 'Receiver registered', SQL_EMP, (p) => p.label],
  ['PUT', /^\/api\/receivers\/(\d+)\/toggle$/, ['Receiver activated', 'Receiver deactivated'], SQL_RCV, (p) => p.label],
  ['DELETE', /^\/api\/receivers\/(\d+)$/, 'Receiver removed', SQL_RCV, (p) => p.label],
  ['POST', /^\/api\/users$/, 'User created', null, (p, b) => `${b.full_name} (${b.username}), role ${b.role}`],
  ['PUT', /^\/api\/users\/(\d+)$/, 'User updated', SQL_USR, (p, b) => `${p.label}, role ${b.role}`],
  ['PUT', /^\/api\/users\/(\d+)\/toggle$/, ['User activated', 'User deactivated'], SQL_USR, (p) => p.label],
  ['PUT', /^\/api\/users\/(\d+)\/password$/, 'Password reset by admin', SQL_USR, (p) => p.label],
  ['PUT', /^\/api\/users\/(\d+)\/unlock$/, 'Account unlocked', SQL_USR, (p) => p.label],
  ['DELETE', /^\/api\/users\/(\d+)$/, 'User deleted', SQL_USR, (p) => p.label],
  ['POST', /^\/api\/document-types$/, 'Document type created', null, (p, b) => b.name],
  ['PUT', /^\/api\/document-types\/(\d+)$/, 'Document type updated', SQL_TYP, (p, b) => `${p.label} -> ${b.name}`],
  ['DELETE', /^\/api\/document-types\/(\d+)$/, 'Document type deleted', SQL_TYP, (p) => p.label],
  ['PUT', /^\/api\/approval-levels\/(\d+)$/, 'Approval level renamed', SQL_LVL, (p, b) => `${p.label} -> ${b.name}`],
  ['PUT', /^\/api\/approval-levels\/(\d+)\/toggle$/, ['Approval level activated', 'Approval level deactivated'], SQL_LVL, (p) => p.label],
];

app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method) || !tokenOf(req)) return next();
  const urlPath = req.originalUrl.split('?')[0];
  let rule, m;
  for (const r of AUDIT_RULES) {
    if (r[0] === req.method && (m = urlPath.match(r[1]))) { rule = r; break; }
  }
  if (!rule) return next();
  (async () => {
    const id = m[1] ?? (req.body || {}).employee_id;
    let before = { label: `#${id}` };
    if (rule[3]) {
      try {
        const [[row]] = await pool.query(rule[3], [id]);
        if (row) before = row;
      } catch (e) { /* the name is only for reading; the id is shown instead */ }
    }
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.user) return;
      const action = Array.isArray(rule[2]) ? (before.active ? rule[2][1] : rule[2][0]) : rule[2];
      audit(req.user, action, rule[4](before, req.body || {}));
    });
  })().then(() => next(), () => next());
});

async function seedUsers() {
  const [[{ c }]] = await pool.query('SELECT COUNT(*) c FROM users');
  if (c > 0) return;
  const [depts] = await pool.query('SELECT id, name FROM departments');
  const dept = (n) => depts.find((d) => d.name === n).id;
  const users = [
    ['System Admin', 'admin', 'admin123', 'admin', 'Records Office'],
    ['Records Clerk', 'clerk', 'clerk123', 'clerk', 'Records Office'],
    ['Registrar Staff', 'registrar', 'registrar123', 'receiver', 'Registrar'],
    ['College Dean', 'dean', 'dean123', 'approver', 'College Dean'],
  ];
  for (const [name, username, pw, role, d] of users) {
    await pool.query(
      'INSERT INTO users (full_name, username, password_hash, role, department_id) VALUES (?,?,?,?,?)',
      [name, username, await bcrypt.hash(pw, 10), role, dept(d)]
    );
  }
  console.log('Default users created (admin/admin123, clerk/clerk123, registrar/registrar123, dean/dean123).');
}

// ---------- auth ----------
const lockedMessage = (secs) => {
  const mins = Math.max(1, Math.ceil(secs / 60));
  return `Too many wrong passwords. This account is locked. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or ask the admin to unlock it.`;
};

app.post('/api/login', h(async (req, res) => {
  // always text, so nobody can send an object instead of a username (SQL injection protection)
  const username = String(req.body.username ?? '');
  const password = String(req.body.password ?? '');
  const [rows] = await pool.query(
    `SELECT u.*, d.name dept_name,
            IF(u.locked_until IS NULL, 0, GREATEST(0, TIMESTAMPDIFF(SECOND, NOW(), u.locked_until))) lock_secs
     FROM users u JOIN departments d ON d.id=u.department_id WHERE u.username=?`,
    [username]
  );
  const u = rows[0];
  if (!u || !u.is_active) {
    await audit({ id: u ? u.id : null, username }, 'Login failed', u ? 'Account is inactive' : 'Unknown username');
    throw new HttpError(401, 'Invalid username or password.');
  }
  // WP25: a locked account is refused before the password is even checked
  if (Number(u.lock_secs) > 0) {
    await audit({ id: u.id }, 'Login blocked', 'Account is locked');
    throw new HttpError(423, lockedMessage(Number(u.lock_secs)));
  }
  if (!(await bcrypt.compare(password, u.password_hash))) {
    const attempts = Number(u.failed_attempts) + 1;
    if (attempts >= MAX_FAILED_LOGINS) {
      await pool.query(`UPDATE users SET failed_attempts=0, locked_until = NOW() + INTERVAL ${LOCK_MINUTES} MINUTE WHERE id=?`, [u.id]);
      await audit({ id: u.id }, 'Account locked', `Locked for ${LOCK_MINUTES} minutes after ${MAX_FAILED_LOGINS} wrong passwords`);
      throw new HttpError(423, lockedMessage(LOCK_MINUTES * 60));
    }
    await pool.query('UPDATE users SET failed_attempts=? WHERE id=?', [attempts, u.id]);
    await audit({ id: u.id }, 'Login failed', `Wrong password (${attempts} of ${MAX_FAILED_LOGINS})`);
    throw new HttpError(401, 'Invalid username or password.');
  }
  // correct password: clear the counter, the lock and any open reset request
  if (Number(u.failed_attempts) || u.locked_until || u.reset_requested)
    await pool.query('UPDATE users SET failed_attempts=0, locked_until=NULL, reset_requested=0 WHERE id=?', [u.id]);
  const token = crypto.randomBytes(24).toString('hex');
  const user = { id: u.id, name: u.full_name, role: u.role, department_id: u.department_id, dept_name: u.dept_name };
  if (u.must_change_password) user.must_change = true;
  await pool.query(`DELETE FROM sessions WHERE created_at < NOW() - INTERVAL ${SESSION_DAYS} DAY`);
  await pool.query('INSERT INTO sessions (token, user_id, user_json) VALUES (?,?,?)', [token, user.id, JSON.stringify(user)]);
  await audit(user, 'Login', user.must_change ? 'Logged in with a temporary password' : 'Logged in');
  res.json({ token, user });
}));

app.post('/api/logout', auth(), h(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token=?', [tokenOf(req)]);
  await audit(req.user, 'Logout', 'Logged out');
  res.json({ ok: true });
}));

// WP25: "Forgot password?" (no login needed). The admin is notified and gives a temporary password.
// The answer is always the same, so nobody can use this to find out which usernames exist.
app.post('/api/forgot-password', h(async (req, res) => {
  const username = String(req.body.username ?? '').trim();
  const [[u]] = await pool.query('SELECT id, full_name, username, is_active FROM users WHERE username=?', [username]);
  await audit({ id: u ? u.id : null, username }, 'Password reset requested',
    u ? (u.is_active ? 'Asked the admin for a temporary password' : 'Account is inactive') : 'Unknown username');
  if (u && u.is_active) {
    await pool.query('UPDATE users SET reset_requested=1 WHERE id=?', [u.id]);
    const msg = `Password reset requested by ${u.full_name} (${u.username}). Go to Users and click Reset password.`.slice(0, 250);
    const adminIds = await idsOf(pool, "SELECT id FROM users WHERE role='admin' AND is_active=1");
    for (const id of adminIds)
      await pool.query(
        `INSERT INTO notifications (user_id, document_id, message)
         SELECT ?, NULL, ? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id=? AND message=? AND is_read=0)`,
        [id, msg, id, msg]);
  }
  res.json({ ok: true, message: 'Request sent. If that username exists, the administrator was told and will give you a temporary password.' });
}));

// ---------- lookups & departments ----------
app.get('/api/lookups', auth(), h(async (req, res) => {
  const [departments] = await pool.query('SELECT id, name, is_active FROM departments ORDER BY name');
  const [types] = await pool.query('SELECT id, name FROM document_types ORDER BY name');
  const [senders] = await pool.query(
    `SELECT s.id, CONCAT(e.employee_no, ' - ', e.full_name) name
     FROM senders s JOIN employees e ON e.id = s.employee_id
     WHERE s.is_active = 1 AND e.is_active = 1 ORDER BY e.full_name`);
  const [receivers] = await pool.query(
    `SELECT r.id, r.department_id, CONCAT(e.employee_no, ' - ', e.full_name) name
     FROM receivers r JOIN employees e ON e.id = r.employee_id
     WHERE r.is_active = 1 AND e.is_active = 1 ORDER BY e.full_name`);
  const [levels] = await pool.query('SELECT id, level_no, name, is_active FROM approval_levels ORDER BY level_no');
  res.json({ departments, types, senders, receivers, levels, max_file_mb: MAX_FILE_MB });
}));

app.post('/api/departments', auth(['admin']), h(async (req, res) => {
  const name = text(req.body.name);
  if (!name) throw new HttpError(400, 'Department name is required.');
  maxLen(name, 100, 'Department name');
  try {
    await pool.query('INSERT INTO departments (name) VALUES (?)', [name]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That department already exists.');
    throw e;
  }
  res.json({ ok: true });
}));

app.put('/api/departments/:id/toggle', auth(['admin']), h(async (req, res) => {
  await pool.query('UPDATE departments SET is_active = 1 - is_active WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.put('/api/departments/:id', auth(['admin']), h(async (req, res) => {
  const name = text(req.body.name);
  if (!name) throw new HttpError(400, 'Department name is required.');
  maxLen(name, 100, 'Department name');
  try {
    await pool.query('UPDATE departments SET name=? WHERE id=?', [name, req.params.id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That department already exists.');
    throw e;
  }
  res.json({ ok: true });
}));

app.delete('/api/departments/:id', auth(['admin']), h(async (req, res) => {
  try {
    await pool.query('DELETE FROM departments WHERE id=?', [req.params.id]);
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2')
      throw new HttpError(400, 'This department is in use and cannot be deleted. Deactivate it instead.');
    throw e;
  }
  res.json({ ok: true });
}));

// ---------- employees, senders, receivers ----------
const manage = ['admin', 'clerk'];

app.get('/api/employees', auth(manage), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT e.*, d.name dept_name, s.id sender_id, r.id receiver_id
     FROM employees e
     JOIN departments d ON d.id = e.department_id
     LEFT JOIN senders s ON s.employee_id = e.id
     LEFT JOIN receivers r ON r.employee_id = e.id
     ORDER BY e.full_name`);
  res.json(rows);
}));

app.get('/api/employees/:id', auth(manage), h(async (req, res) => {
  const [[employee]] = await pool.query(
    `SELECT e.*, d.name dept_name FROM employees e
     JOIN departments d ON d.id = e.department_id WHERE e.id=?`, [req.params.id]);
  if (!employee) throw new HttpError(404, 'Employee not found.');
  const [[sender]] = await pool.query('SELECT * FROM senders WHERE employee_id=?', [employee.id]);
  const [[receiver]] = await pool.query(
    `SELECT r.*, d.name dept_name FROM receivers r
     JOIN departments d ON d.id = r.department_id WHERE r.employee_id=?`, [employee.id]);
  res.json({ employee, sender: sender || null, receiver: receiver || null });
}));

async function saveEmployee(req, res, id) {
  const { department_id } = req.body;
  const employee_no = text(req.body.employee_no), full_name = text(req.body.full_name);
  const position = text(req.body.position), email = text(req.body.email);
  if (!employee_no || !full_name || !department_id)
    throw new HttpError(400, 'Employee no., full name and department are required.');
  maxLen(employee_no, 30, 'Employee no.'); maxLen(full_name, 100, 'Full name');
  maxLen(position, 80, 'Position'); maxLen(email, 100, 'Email');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const vals = [employee_no, full_name, position || null, email || null, department_id];
  try {
    if (id) {
      await pool.query(
        'UPDATE employees SET employee_no=?, full_name=?, position=?, email=?, department_id=? WHERE id=?',
        [...vals, id]);
    } else {
      await pool.query(
        'INSERT INTO employees (employee_no, full_name, position, email, department_id) VALUES (?,?,?,?,?)', vals);
    }
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That employee number already exists.');
    throw e;
  }
  res.json({ ok: true });
}
app.post('/api/employees', auth(manage), h((req, res) => saveEmployee(req, res)));
app.put('/api/employees/:id', auth(manage), h((req, res) => saveEmployee(req, res, req.params.id)));

app.put('/api/employees/:id/toggle', auth(manage), h(async (req, res) => {
  await pool.query('UPDATE employees SET is_active = 1 - is_active WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/employees/:id', auth(manage), h(async (req, res) => {
  try {
    await pool.query('DELETE FROM employees WHERE id=?', [req.params.id]);
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2')
      throw new HttpError(400, 'This employee is registered as a sender or receiver. Remove that first.');
    throw e;
  }
  res.json({ ok: true });
}));

async function activeEmployee(employee_id) {
  const [[e]] = await pool.query('SELECT * FROM employees WHERE id=?', [employee_id]);
  if (!e) throw new HttpError(400, 'Choose an employee.');
  if (!e.is_active) throw new HttpError(400, 'That employee is inactive.');
  return e;
}

app.get('/api/senders', auth(manage), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT s.id, s.employee_id, s.is_active, e.employee_no, e.full_name, d.name dept_name
     FROM senders s JOIN employees e ON e.id = s.employee_id
     JOIN departments d ON d.id = e.department_id ORDER BY e.full_name`);
  res.json(rows);
}));

app.post('/api/senders', auth(manage), h(async (req, res) => {
  const e = await activeEmployee(req.body.employee_id);
  try {
    await pool.query('INSERT INTO senders (employee_id) VALUES (?)', [e.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That employee is already a sender.');
    throw err;
  }
  res.json({ ok: true });
}));

app.put('/api/senders/:id/toggle', auth(manage), h(async (req, res) => {
  await pool.query('UPDATE senders SET is_active = 1 - is_active WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/senders/:id', auth(manage), h(async (req, res) => {
  await pool.query('DELETE FROM senders WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/receivers', auth(manage), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.id, r.employee_id, r.is_active, e.employee_no, e.full_name, d.name dept_name
     FROM receivers r JOIN employees e ON e.id = r.employee_id
     JOIN departments d ON d.id = r.department_id ORDER BY e.full_name`);
  res.json(rows);
}));

app.post('/api/receivers', auth(manage), h(async (req, res) => {
  const e = await activeEmployee(req.body.employee_id);
  const [[dept]] = await pool.query('SELECT * FROM departments WHERE id=?', [req.body.department_id]);
  if (!dept || !dept.is_active) throw new HttpError(400, 'Choose an active receiving department.');
  try {
    await pool.query('INSERT INTO receivers (employee_id, department_id) VALUES (?,?)', [e.id, dept.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That employee is already a receiver.');
    throw err;
  }
  res.json({ ok: true });
}));

app.put('/api/receivers/:id/toggle', auth(manage), h(async (req, res) => {
  await pool.query('UPDATE receivers SET is_active = 1 - is_active WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/receivers/:id', auth(manage), h(async (req, res) => {
  await pool.query('DELETE FROM receivers WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- user accounts ----------
const ROLES = ['admin', 'clerk', 'sender', 'receiver', 'approver', 'office_staff'];

function dropSessions(userId) {
  return pool.query('DELETE FROM sessions WHERE user_id=?', [Number(userId)]);
}

function checkPassword(pw) {
  if (!pw || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
}

// an approver must have an approval level; everyone else has none
async function levelFor(role, approval_level_id) {
  if (role !== 'approver') return null;
  const [[lvl]] = await pool.query('SELECT id FROM approval_levels WHERE id=?', [approval_level_id || 0]);
  if (!lvl) throw new HttpError(400, 'Choose an approval level for an approver.');
  return lvl.id;
}

async function checkUserFields({ full_name, role, department_id }) {
  if (!text(full_name) || !department_id) throw new HttpError(400, 'Full name and department are required.');
  maxLen(full_name, 100, 'Full name');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a valid role.');
  const [[dept]] = await pool.query('SELECT * FROM departments WHERE id=?', [department_id]);
  if (!dept || !dept.is_active) throw new HttpError(400, 'Choose an active department.');
  return dept;
}

app.get('/api/users', auth(['admin']), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.username, u.role, u.department_id, u.is_active, d.name dept_name,
            u.approval_level_id, CONCAT('Level ', al.level_no, ' - ', al.name) level_name,
            (u.locked_until IS NOT NULL AND u.locked_until > NOW()) locked, u.reset_requested
     FROM users u JOIN departments d ON d.id = u.department_id
     LEFT JOIN approval_levels al ON al.id = u.approval_level_id ORDER BY u.full_name`);
  res.json(rows);
}));

app.post('/api/users', auth(['admin']), h(async (req, res) => {
  const { full_name, username, password, role, department_id } = req.body;
  await checkUserFields(req.body);
  if (!/^[A-Za-z0-9._-]{3,50}$/.test((username || '').trim()))
    throw new HttpError(400, 'Username must be 3-50 characters: letters, numbers, dot, dash or underscore.');
  checkPassword(password);
  const levelId = await levelFor(role, req.body.approval_level_id);
  try {
    await pool.query(
      'INSERT INTO users (full_name, username, password_hash, role, department_id, approval_level_id) VALUES (?,?,?,?,?,?)',
      [full_name.trim(), username.trim(), await bcrypt.hash(password, 10), role, department_id, levelId]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That username is already taken.');
    throw e;
  }
  res.json({ ok: true });
}));

app.put('/api/users/:id', auth(['admin']), h(async (req, res) => {
  const { full_name, role, department_id } = req.body;
  const dept = await checkUserFields(req.body);
  const isSelf = Number(req.params.id) === req.user.id;
  if (isSelf && role !== req.user.role) throw new HttpError(400, 'You cannot change your own role.');
  const levelId = await levelFor(role, req.body.approval_level_id);
  await pool.query('UPDATE users SET full_name=?, role=?, department_id=?, approval_level_id=? WHERE id=?',
    [full_name.trim(), role, department_id, levelId, req.params.id]);
  if (isSelf) {
    req.user.name = full_name.trim();
    req.user.department_id = dept.id;
    req.user.dept_name = dept.name;
  } else {
    await dropSessions(req.params.id); // they log in again to get the new role
  }
  res.json({ ok: true });
}));

app.put('/api/users/:id/toggle', auth(['admin']), h(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'You cannot deactivate your own account.');
  await pool.query('UPDATE users SET is_active = 1 - is_active WHERE id=?', [req.params.id]);
  await dropSessions(req.params.id);
  res.json({ ok: true });
}));

// WP25: the admin gives a temporary password; the user must choose their own at the next login.
// (An admin resetting their own password chooses it themselves, so no forced change.)
app.put('/api/users/:id/password', auth(['admin']), h(async (req, res) => {
  checkPassword(req.body.new_password);
  const self = Number(req.params.id) === req.user.id;
  await pool.query(
    'UPDATE users SET password_hash=?, failed_attempts=0, locked_until=NULL, reset_requested=0, must_change_password=? WHERE id=?',
    [await bcrypt.hash(req.body.new_password, 10), self ? 0 : 1, req.params.id]);
  if (!self) await dropSessions(req.params.id);
  res.json({ ok: true });
}));

// WP25: the admin can unlock a locked account without waiting
app.put('/api/users/:id/unlock', auth(['admin']), h(async (req, res) => {
  await pool.query('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=?', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/users/:id', auth(['admin']), h(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'You cannot delete your own account.');
  try {
    await pool.query('DELETE FROM users WHERE id=?', [req.params.id]);
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2')
      throw new HttpError(400, 'This user has records (documents, routing, etc.) and cannot be deleted. Deactivate the account instead.');
    throw e;
  }
  await dropSessions(req.params.id);
  res.json({ ok: true });
}));

// any logged-in user can change their own password
app.post('/api/me/password', auth(), h(async (req, res) => {
  const { current_password, new_password } = req.body;
  const [[u]] = await pool.query('SELECT password_hash FROM users WHERE id=?', [req.user.id]);
  if (!(await bcrypt.compare(current_password || '', u.password_hash)))
    throw new HttpError(400, 'Current password is incorrect.');
  checkPassword(new_password);
  if (new_password === current_password) throw new HttpError(400, 'New password must be different.');
  await pool.query('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', [await bcrypt.hash(new_password, 10), req.user.id]);
  await audit(req.user, 'Password changed', req.user.must_change ? 'Chose a new password after an admin reset' : 'Changed own password');
  // other devices that were logged in with the old password are logged out
  await pool.query('DELETE FROM sessions WHERE user_id=? AND token<>?', [req.user.id, tokenOf(req)]);
  if (req.user.must_change) {
    const { must_change, ...rest } = req.user;
    await pool.query('UPDATE sessions SET user_json=? WHERE token=?', [JSON.stringify(rest), tokenOf(req)]);
  }
  res.json({ ok: true });
}));

// ---------- document types ----------
app.get('/api/document-types', auth(manage), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT t.id, t.name, COUNT(d.id) doc_count
     FROM document_types t LEFT JOIN documents d ON d.type_id = t.id
     GROUP BY t.id, t.name ORDER BY t.name`);
  res.json(rows);
}));

async function saveDocType(req, res, id) {
  const name = (req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Document type name is required.');
  if (name.length > 80) throw new HttpError(400, 'Document type name must be 80 characters or less.');
  try {
    if (id) await pool.query('UPDATE document_types SET name=? WHERE id=?', [name, id]);
    else await pool.query('INSERT INTO document_types (name) VALUES (?)', [name]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw new HttpError(400, 'That document type already exists.');
    throw e;
  }
  res.json({ ok: true });
}
app.post('/api/document-types', auth(manage), h((req, res) => saveDocType(req, res)));
app.put('/api/document-types/:id', auth(manage), h((req, res) => saveDocType(req, res, req.params.id)));

app.delete('/api/document-types/:id', auth(manage), h(async (req, res) => {
  try {
    await pool.query('DELETE FROM document_types WHERE id=?', [req.params.id]);
  } catch (e) {
    if (e.code === 'ER_ROW_IS_REFERENCED_2')
      throw new HttpError(400, 'This document type is used by existing documents and cannot be deleted.');
    throw e;
  }
  res.json({ ok: true });
}));

// ---------- file uploads (stored inside the database, so they also work on Vercel) ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads'); // only used to read files uploaded before this update
const MAX_FILE_MB = isVercel ? 4 : 5; // Vercel allows a request of about 4.5 MB at most
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const FILE_TYPES = {
  '.pdf': ['application/pdf'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp'],
};
const TYPE_MESSAGE = 'Only PDF, DOCX, XLSX and image files (PNG, JPG, GIF, WEBP) are allowed.';
const fileRoles = ['admin', 'clerk', 'sender'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = FILE_TYPES[ext] && (FILE_TYPES[ext].includes(file.mimetype) || file.mimetype === 'application/octet-stream');
    cb(ok ? null : new HttpError(400, TYPE_MESSAGE), !!ok);
  },
});

// files uploaded before this update still live in the uploads folder (local use only)
const removeFile = (name) => {
  if (name && !name.startsWith('db-')) fs.unlink(path.join(UPLOAD_DIR, name), () => {});
};

function receiveFile(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, `File is too large. The maximum size is ${MAX_FILE_MB} MB.`));
        if (err instanceof HttpError) return reject(err);
        return reject(new HttpError(400, 'Upload failed: ' + err.message));
      }
      if (!req.file) return reject(new HttpError(400, 'Choose a file to upload.'));
      resolve(req.file);
    });
  });
}

// the first bytes of the file must match the type it claims to be
function verifySignature(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const buf = file.buffer.subarray(0, 12);
  const head = buf.toString('latin1');
  let ok = false;
  if (ext === '.pdf') ok = head.startsWith('%PDF');
  else if (ext === '.docx' || ext === '.xlsx') ok = buf[0] === 0x50 && buf[1] === 0x4b;
  else if (ext === '.png') ok = buf[0] === 0x89 && head.slice(1, 4) === 'PNG';
  else if (ext === '.jpg' || ext === '.jpeg') ok = buf[0] === 0xff && buf[1] === 0xd8;
  else if (ext === '.gif') ok = head.startsWith('GIF8');
  else if (ext === '.webp') ok = head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP';
  if (!ok) throw new HttpError(400, 'The file content does not match its type.');
}

const originalName = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255);
const storedName = (file) =>
  `db-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;

app.post('/api/documents/:id/files', auth(fileRoles), h(async (req, res) => {
  const file = await receiveFile(req, res);
  verifySignature(file);
  const name = originalName(file);
  await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (['Released', 'Archived'].includes(doc.status)) throw new HttpError(400, 'Files cannot be changed after the document is released.');
    await conn.query(
      `INSERT INTO files (document_id, original_name, stored_name, file_type, file_size, file_data, uploaded_by)
       VALUES (?,?,?,?,?,?,?)`,
      [doc.id, name, storedName(file), file.mimetype, file.size, file.buffer, req.user.id]);
    await track(conn, doc.id, 'File uploaded', name, req.user.id);
  });
  res.json({ ok: true });
}));

app.put('/api/files/:id', auth(fileRoles), h(async (req, res) => {
  const file = await receiveFile(req, res);
  verifySignature(file);
  const name = originalName(file);
  let oldStored;
  await tx(async (conn) => {
    const [[f]] = await conn.query(
      `SELECT f.id, f.document_id, f.original_name, f.stored_name, f.uploaded_by, d.status
       FROM files f JOIN documents d ON d.id = f.document_id WHERE f.id=? FOR UPDATE`, [req.params.id]);
    if (!f) throw new HttpError(404, 'File not found.');
    if (['Released', 'Archived'].includes(f.status)) throw new HttpError(400, 'Files cannot be changed after the document is released.');
    if (req.user.role === 'sender' && f.uploaded_by !== req.user.id)
      throw new HttpError(403, 'You can only replace files you uploaded.');
    await conn.query(
      `UPDATE files SET original_name=?, stored_name=?, file_type=?, file_size=?, file_data=?, uploaded_by=?, uploaded_at=NOW() WHERE id=?`,
      [name, storedName(file), file.mimetype, file.size, file.buffer, req.user.id, f.id]);
    await track(conn, f.document_id, 'File replaced', `${f.original_name} -> ${name}`, req.user.id);
    oldStored = f.stored_name;
  });
  removeFile(oldStored);
  res.json({ ok: true });
}));

app.delete('/api/files/:id', auth(fileRoles), h(async (req, res) => {
  let stored;
  await tx(async (conn) => {
    const [[f]] = await conn.query(
      `SELECT f.id, f.document_id, f.original_name, f.stored_name, f.uploaded_by, d.status
       FROM files f JOIN documents d ON d.id = f.document_id WHERE f.id=? FOR UPDATE`, [req.params.id]);
    if (!f) throw new HttpError(404, 'File not found.');
    if (['Released', 'Archived'].includes(f.status)) throw new HttpError(400, 'Files cannot be changed after the document is released.');
    if (req.user.role === 'sender' && f.uploaded_by !== req.user.id)
      throw new HttpError(403, 'You can only delete files you uploaded.');
    await conn.query('DELETE FROM files WHERE id=?', [f.id]);
    await track(conn, f.document_id, 'File deleted', f.original_name, req.user.id);
    stored = f.stored_name;
  });
  removeFile(stored);
  res.json({ ok: true });
}));

app.get('/api/files/:id/download', auth(), h(async (req, res) => {
  const [[f]] = await pool.query('SELECT * FROM files WHERE id=?', [req.params.id]);
  if (!f) throw new HttpError(404, 'File not found.');
  await audit(req.user, 'File downloaded', f.original_name, f.document_id);
  if (f.file_data) {
    res.attachment(f.original_name);
    return res.send(f.file_data);
  }
  // older file saved on disk (local use only)
  const full = path.join(UPLOAD_DIR, f.stored_name);
  if (!fs.existsSync(full)) throw new HttpError(404, 'The file is missing from the server.');
  res.download(full, f.original_name);
}));

// ---------- inbox (documents routed to my department) ----------
app.get('/api/inbox', auth(), h(async (req, res) => {
  const { q = '', status = '', sort = 'newest' } = req.query;
  const orderBy = {
    newest: 'r.routed_at DESC',
    oldest: 'r.routed_at ASC',
    due: 'r.due_date IS NULL, r.due_date ASC',
    title: 'd.title ASC',
  }[sort] || 'r.routed_at DESC';
  let sql = `SELECT r.id routing_id, d.id doc_id, d.doc_number, d.title, tp.name type_name,
      f.name from_name, t.name to_name, r.status, r.routed_at,
      DATE_FORMAT(r.due_date, '%Y-%m-%d') due_date,
      CONCAT(e.employee_no, ' - ', e.full_name) receiver_name,
      (r.status = 'Pending' AND (r.routed_at < NOW() - INTERVAL ${OVERDUE_DAYS} DAY OR r.due_date < CURDATE())) overdue
    FROM routing r
    JOIN documents d ON d.id = r.document_id
    JOIN document_types tp ON tp.id = d.type_id
    JOIN departments f ON f.id = r.from_dept_id
    JOIN departments t ON t.id = r.to_dept_id
    LEFT JOIN receivers rc ON rc.id = r.receiver_id
    LEFT JOIN employees e ON e.id = rc.employee_id
    WHERE (d.doc_number LIKE ? OR d.title LIKE ?)`;
  const params = [`%${q}%`, `%${q}%`];
  if (req.user.role !== 'admin') { sql += ' AND r.to_dept_id = ?'; params.push(req.user.department_id); }
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  sql += ` ORDER BY ${orderBy}`;
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));

// ---------- documents ----------
app.get('/api/documents', auth(), h(async (req, res) => {
  const { q = '', status = '' } = req.query;
  let sql = `SELECT d.id, d.doc_number, d.title, d.status, d.created_at, t.name type_name, o.name origin_name
             FROM documents d
             JOIN document_types t ON t.id = d.type_id
             JOIN departments o ON o.id = d.origin_dept_id
             WHERE (d.doc_number LIKE ? OR d.title LIKE ?)`;
  const params = [`%${q}%`, `%${q}%`];
  if (status) { sql += ' AND d.status = ?'; params.push(status); }
  sql += ' ORDER BY d.id DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));

// register a document with automatic, duplicate-proof numbering
app.post('/api/documents', auth(['admin', 'clerk']), h(async (req, res) => {
  const { type_id, origin_dept_id, sender_id } = req.body;
  const title = text(req.body.title), description = text(req.body.description);
  if (!title || !type_id || !origin_dept_id)
    throw new HttpError(400, 'Title, document type and origin department are required.');
  maxLen(title, 200, 'Title'); maxLen(description, 2000, 'Description');
  if (!sender_id) throw new HttpError(400, 'Choose a sender. Register senders first in Senders & Receivers.');
  const [[typ]] = await pool.query('SELECT id FROM document_types WHERE id=?', [type_id]);
  if (!typ) throw new HttpError(400, 'Choose a valid document type.');
  const [[org]] = await pool.query('SELECT id FROM departments WHERE id=? AND is_active=1', [origin_dept_id]);
  if (!org) throw new HttpError(400, 'Choose an active origin department.');
  const [[snd]] = await pool.query(
    `SELECT s.id FROM senders s JOIN employees e ON e.id = s.employee_id
     WHERE s.id=? AND s.is_active=1 AND e.is_active=1`, [sender_id]);
  if (!snd) throw new HttpError(400, 'That sender is not registered or is inactive.');
  const result = await tx(async (conn) => {
    const year = new Date().getFullYear();
    await conn.query(
      'INSERT INTO doc_counters (year, last_no) VALUES (?, 1) ON DUPLICATE KEY UPDATE last_no = last_no + 1',
      [year]
    );
    const [[{ last_no }]] = await conn.query('SELECT last_no FROM doc_counters WHERE year=?', [year]);
    const num = `DTS-${year}-${String(last_no).padStart(5, '0')}`;
    const [r] = await conn.query(
      'INSERT INTO documents (doc_number, title, description, type_id, origin_dept_id, sender_id, created_by) VALUES (?,?,?,?,?,?,?)',
      [num, title, description || null, type_id, origin_dept_id, snd.id, req.user.id]
    );
    await track(conn, r.insertId, 'Registered', `Registered as ${num}`, req.user.id);
    return { id: r.insertId, doc_number: num };
  });
  res.json(result);
}));

// WP15-17: where is this document in the approval chain?
// The chain is the active approval levels in order. Only approvals made after the latest routing count.
async function approvalProgress(conn, docId) {
  const [[last]] = await conn.query('SELECT id FROM routing WHERE document_id=? ORDER BY id DESC LIMIT 1', [docId]);
  const [levels] = await conn.query('SELECT id, level_no, name FROM approval_levels WHERE is_active=1 ORDER BY level_no');
  const [recs] = last
    ? await conn.query(
        `SELECT level_id, decision FROM approvals
         WHERE document_id=? AND routing_id=? AND level_id IS NOT NULL ORDER BY id`, [docId, last.id])
    : [[]];
  const chain = levels.map((l) => {
    const rec = [...recs].reverse().find((x) => x.level_id === l.id);
    return { ...l, state: rec ? rec.decision : 'Pending' };
  });
  return { routingId: last ? last.id : null, chain, next: chain.find((l) => l.state !== 'Approved') || null };
}

// document profile: details + routing + approvals + release + tracking history
app.get('/api/documents/:id', auth(), h(async (req, res) => {
  const [[doc]] = await pool.query(
    `SELECT d.*, t.name type_name, o.name origin_name, u.full_name created_by_name,
            CONCAT(se.employee_no, ' - ', se.full_name) sender_name
     FROM documents d
     JOIN document_types t ON t.id = d.type_id
     JOIN departments o ON o.id = d.origin_dept_id
     JOIN users u ON u.id = d.created_by
     LEFT JOIN senders sn ON sn.id = d.sender_id
     LEFT JOIN employees se ON se.id = sn.employee_id
     WHERE d.id=?`, [req.params.id]);
  if (!doc) throw new HttpError(404, 'Document not found.');
  const [routing] = await pool.query(
    `SELECT r.*, DATE_FORMAT(r.due_date, '%Y-%m-%d') due_date, f.name from_name, t.name to_name,
            u.full_name routed_by_name, rc.full_name received_by_name,
            CONCAT(re.employee_no, ' - ', re.full_name) receiver_name
     FROM routing r
     JOIN departments f ON f.id = r.from_dept_id
     JOIN departments t ON t.id = r.to_dept_id
     JOIN users u ON u.id = r.routed_by
     LEFT JOIN users rc ON rc.id = r.received_by
     LEFT JOIN receivers rv ON rv.id = r.receiver_id
     LEFT JOIN employees re ON re.id = rv.employee_id
     WHERE r.document_id=? ORDER BY r.id`, [doc.id]);
  const [approvals] = await pool.query(
    `SELECT a.*, u.full_name approver_name, l.level_no, l.name level_name FROM approvals a
     JOIN users u ON u.id = a.approver_id
     LEFT JOIN approval_levels l ON l.id = a.level_id WHERE a.document_id=? ORDER BY a.id`, [doc.id]);
  const [releases] = await pool.query(
    `SELECT r.*, u.full_name released_by_name FROM releases r
     JOIN users u ON u.id = r.released_by WHERE r.document_id=? ORDER BY r.id`, [doc.id]);
  const [history] = await pool.query(
    `SELECT h.*, u.full_name user_name FROM tracking_history h
     JOIN users u ON u.id = h.user_id WHERE h.document_id=? ORDER BY h.id`, [doc.id]);
  const [files] = await pool.query(
    `SELECT f.id, f.document_id, f.original_name, f.stored_name, f.file_type, f.file_size,
            f.uploaded_by, f.uploaded_at, u.full_name uploaded_by_name FROM files f
     JOIN users u ON u.id = f.uploaded_by WHERE f.document_id=? ORDER BY f.id`, [doc.id]);
  // approval progress (documents approved before WP15-17 have no levels, so they show none)
  let approval = null;
  if (['Received', 'Approved', 'Rejected', 'Released'].includes(doc.status) && !approvals.some((a) => !a.level_id)) {
    const { chain, next } = await approvalProgress(pool, doc.id);
    approval = { chain, next, can_decide: false, note: '' };
    if (doc.status === 'Received' && next) {
      if (req.user.role === 'admin') {
        approval.can_decide = true;
        approval.note = 'You are the admin, so you can decide on behalf of this level.';
      } else if (req.user.role === 'approver') {
        const [[me]] = await pool.query('SELECT approval_level_id FROM users WHERE id=?', [req.user.id]);
        if (!me.approval_level_id) approval.note = 'Your account has no approval level. Ask the admin to set it in Users.';
        else if (me.approval_level_id === next.id) approval.can_decide = true;
        else approval.note = `Waiting for Level ${next.level_no} - ${next.name}. It is not your level's turn yet.`;
      }
    }
  }
  res.json({ doc, routing, approvals, releases, files, history, approval });
}));

// route a document to another department
app.post('/api/documents/:id/route', auth(), h(async (req, res) => {
  const { to_dept_id, receiver_id } = req.body;
  const due_date = text(req.body.due_date), purpose = text(req.body.purpose), instructions = text(req.body.instructions);
  if (!to_dept_id) throw new HttpError(400, 'Choose a destination department.');
  maxLen(purpose, 200, 'Purpose'); maxLen(instructions, 2000, 'Instructions');
  const todayStr = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (due_date) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(due_date) && new Date(due_date + 'T00:00:00Z').toISOString().slice(0, 10) === due_date;
    if (!valid || due_date < todayStr) throw new HttpError(400, 'Enter a valid due date that is not in the past.');
  }
  await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (!['Registered', 'Returned', 'Received'].includes(doc.status))
      throw new HttpError(400, `A document with status "${doc.status}" cannot be routed.`);

    // no unauthorized re-routing
    if (doc.status === 'Received') {
      const [[last]] = await conn.query(
        'SELECT to_dept_id FROM routing WHERE document_id=? ORDER BY id DESC LIMIT 1', [doc.id]);
      if (req.user.role !== 'admin' && req.user.department_id !== last.to_dept_id)
        throw new HttpError(403, 'Only the department holding this document can re-route it.');
    } else if (!['admin', 'clerk'].includes(req.user.role)) {
      throw new HttpError(403, 'Only the records clerk or admin can route this document.');
    }

    const [[dest]] = await conn.query('SELECT * FROM departments WHERE id=?', [to_dept_id]);
    if (!dest || !dest.is_active) throw new HttpError(400, 'Destination department is invalid or inactive.');
    if (dest.id === req.user.department_id)
      throw new HttpError(400, 'You cannot route a document to your own department.');

    // the assigned receiver must be active and belong to the destination department
    const [[rcv]] = await conn.query(
      `SELECT rc.id, CONCAT(e.employee_no, ' - ', e.full_name) name
       FROM receivers rc JOIN employees e ON e.id = rc.employee_id
       WHERE rc.id=? AND rc.department_id=? AND rc.is_active=1 AND e.is_active=1`, [receiver_id || 0, dest.id]);
    if (!rcv) throw new HttpError(400, 'Choose an active receiver that belongs to the destination department.');

    await conn.query(
      `INSERT INTO routing (document_id, from_dept_id, to_dept_id, receiver_id, purpose, instructions, due_date, routed_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [doc.id, req.user.department_id, dest.id, rcv.id, purpose || null, instructions || null, due_date || null, req.user.id]);
    await conn.query("UPDATE documents SET status='Routed' WHERE id=?", [doc.id]);
    await track(conn, doc.id, 'Routed',
      `Routed to ${dest.name}, assigned to ${rcv.name}` + (purpose ? ` (${purpose})` : ''), req.user.id);
    await notify(conn, await idsOf(conn, 'SELECT id FROM users WHERE department_id=? AND is_active=1', [dest.id]),
      doc.id, `Routed to your department: ${doc.doc_number} - ${doc.title}`, req.user.id);
  });
  res.json({ ok: true });
}));

// acknowledgment receipt number, e.g. ACK-2026-00005
const ackNo = (routingId, year) => `ACK-${year}-${String(routingId).padStart(5, '0')}`;

// receive or return a routed document
async function respondToRouting(req, res, action) {
  const remarks = text(req.body.remarks);
  maxLen(remarks, 1000, 'Remarks');
  if (['Returned', 'Rejected'].includes(action) && !remarks)
    throw new HttpError(400, `Remarks are required when ${action === 'Returned' ? 'returning' : 'rejecting'} a document.`);
  await tx(async (conn) => {
    const [[r]] = await conn.query('SELECT * FROM routing WHERE id=? FOR UPDATE', [req.params.id]);
    if (!r) throw new HttpError(404, 'Routing record not found.');
    if (r.status !== 'Pending') throw new HttpError(400, 'This routing was already handled.');
    if (req.user.role !== 'admin' && req.user.department_id !== r.to_dept_id)
      throw new HttpError(403, 'This document was not routed to your department.');
    await conn.query(
      'UPDATE routing SET status=?, received_by=?, received_at=NOW(), remarks=? WHERE id=?',
      [action, req.user.id, remarks || null, r.id]);
    await conn.query('UPDATE documents SET status=? WHERE id=?', [action, r.document_id]);
    let details = remarks || `${action} by ${req.user.dept_name}`;
    if (action === 'Received') {
      // WP14: receiving a document issues an acknowledgment receipt
      const [[{ y }]] = await conn.query('SELECT YEAR(received_at) y FROM routing WHERE id=?', [r.id]);
      details = `Acknowledged receipt ${ackNo(r.id, y)} by ${req.user.dept_name}` + (remarks ? ` - ${remarks}` : '');
    }
    await track(conn, r.document_id, action, details, req.user.id);

    // WP22: notifications
    const [[doc]] = await conn.query('SELECT doc_number, created_by FROM documents WHERE id=?', [r.document_id]);
    const people = [doc.created_by, r.routed_by];
    if (action === 'Received') {
      await notify(conn, people, r.document_id, `Received: ${doc.doc_number} was received by ${req.user.dept_name}.`, req.user.id);
      const { next } = await approvalProgress(conn, r.document_id);
      if (next)
        await notify(conn, await approverIds(conn, next), r.document_id,
          `Approval required: ${doc.doc_number} is waiting for Level ${next.level_no} - ${next.name}.`, req.user.id);
    } else {
      await notify(conn, people, r.document_id, `${action}: ${doc.doc_number} was ${action.toLowerCase()} by ${req.user.dept_name}. ${remarks}`, req.user.id);
    }
  });
  res.json({ ok: true });
}
app.post('/api/routing/:id/receive', auth(), h((req, res) => respondToRouting(req, res, 'Received')));
app.post('/api/routing/:id/return', auth(), h((req, res) => respondToRouting(req, res, 'Returned')));
app.post('/api/routing/:id/reject', auth(), h((req, res) => respondToRouting(req, res, 'Rejected')));

// WP14: acknowledgment receipt of a received routing
app.get('/api/routing/:id/acknowledgment', auth(), h(async (req, res) => {
  const [[r]] = await pool.query(
    `SELECT r.id, r.status, r.from_dept_id, r.to_dept_id, r.purpose, r.remarks, r.routed_at, r.received_at,
            d.doc_number, d.title, tp.name type_name,
            f.name from_name, t.name to_name,
            ru.full_name routed_by_name, rc.full_name received_by_name, rcd.name received_by_dept,
            CONCAT(re.employee_no, ' - ', re.full_name) receiver_name
     FROM routing r
     JOIN documents d ON d.id = r.document_id
     JOIN document_types tp ON tp.id = d.type_id
     JOIN departments f ON f.id = r.from_dept_id
     JOIN departments t ON t.id = r.to_dept_id
     JOIN users ru ON ru.id = r.routed_by
     LEFT JOIN users rc ON rc.id = r.received_by
     LEFT JOIN departments rcd ON rcd.id = rc.department_id
     LEFT JOIN receivers rv ON rv.id = r.receiver_id
     LEFT JOIN employees re ON re.id = rv.employee_id
     WHERE r.id=?`, [req.params.id]);
  if (!r) throw new HttpError(404, 'Routing record not found.');
  if (r.status !== 'Received') throw new HttpError(400, 'An acknowledgment receipt exists only for a received document.');
  const allowed = ['admin', 'clerk'].includes(req.user.role) ||
    [r.from_dept_id, r.to_dept_id].includes(req.user.department_id);
  if (!allowed) throw new HttpError(403, 'You are not allowed to view this receipt.');
  res.json({ ...r, ack_no: ackNo(r.id, new Date(r.received_at).getFullYear()) });
}));

// approve or reject, one approval level at a time (WP15-17)
app.post('/api/documents/:id/approve', auth(['admin', 'approver']), h(async (req, res) => {
  const { decision } = req.body;
  const comments = text(req.body.comments);
  if (!['Approved', 'Rejected'].includes(decision)) throw new HttpError(400, 'Invalid decision.');
  if (decision === 'Rejected' && !comments)
    throw new HttpError(400, 'Comments are required when rejecting a document.');
  maxLen(comments, 1000, 'Comments');
  await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (doc.status !== 'Received')
      throw new HttpError(400, 'Only a received document can be approved or rejected.');
    const { routingId, chain, next } = await approvalProgress(conn, doc.id);
    if (!next) throw new HttpError(400, 'There is no active approval level. The admin must activate one in Approval Levels.');
    if (req.user.role === 'approver') {
      const [[me]] = await conn.query('SELECT approval_level_id FROM users WHERE id=?', [req.user.id]);
      if (!me.approval_level_id)
        throw new HttpError(403, 'Your account has no approval level. Ask the admin to set it in Users.');
      if (me.approval_level_id !== next.id)
        throw new HttpError(403, `This document is waiting for Level ${next.level_no} - ${next.name}. It is not your level's turn.`);
    }
    await conn.query(
      'INSERT INTO approvals (document_id, approver_id, decision, comments, level_id, routing_id) VALUES (?,?,?,?,?,?)',
      [doc.id, req.user.id, decision, (comments || '').trim() || null, next.id, routingId]);

    const lvl = `Level ${next.level_no} - ${next.name}`;
    const by = req.user.role === 'admin' ? ` (by admin ${req.user.name})` : '';
    const note = (comments || '').trim() ? ` Comment: ${comments.trim()}` : '';
    let action = decision;
    let details;
    let nextLevel = null;
    if (decision === 'Rejected') {
      await conn.query("UPDATE documents SET status='Rejected' WHERE id=?", [doc.id]);
      details = `Rejected at ${lvl}${by}.${note}`;
    } else {
      const remaining = chain.filter((l) => l.id !== next.id && l.state !== 'Approved');
      const done = chain.length - remaining.length;
      if (remaining.length) {
        action = 'Level approved'; // the document stays "Received" until every level has approved
        nextLevel = remaining[0];
        details = `${lvl} approved${by} (${done} of ${chain.length}). Waiting for Level ${remaining[0].level_no} - ${remaining[0].name}.${note}`;
      } else {
        await conn.query("UPDATE documents SET status='Approved' WHERE id=?", [doc.id]);
        details = `${lvl} approved${by} (${done} of ${chain.length}). Fully approved.${note}`;
      }
    }
    await track(conn, doc.id, action, details.slice(0, 295), req.user.id);

    // WP22: notifications
    if (nextLevel)
      await notify(conn, await approverIds(conn, nextLevel), doc.id,
        `Approval required: ${doc.doc_number} is waiting for Level ${nextLevel.level_no} - ${nextLevel.name}.`, req.user.id);
    else if (decision === 'Rejected')
      await notify(conn, [doc.created_by, ...(await clerkIds(conn))], doc.id, `Rejected: ${doc.doc_number} was rejected at ${lvl}.`, req.user.id);
    else
      await notify(conn, [doc.created_by, ...(await clerkIds(conn))], doc.id, `Approved: ${doc.doc_number} is fully approved and ready for release.`, req.user.id);
  });
  res.json({ ok: true });
}));

// approval levels (admin manages; everyone can read them through /api/lookups)
app.get('/api/approval-levels', auth(), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT l.id, l.level_no, l.name, l.is_active,
            (SELECT COUNT(*) FROM users u WHERE u.approval_level_id = l.id AND u.is_active = 1) approvers
     FROM approval_levels l ORDER BY l.level_no`);
  res.json(rows);
}));

app.put('/api/approval-levels/:id', auth(['admin']), h(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'Level name is required (up to 60 characters).');
  await pool.query('UPDATE approval_levels SET name=? WHERE id=?', [name, req.params.id]);
  res.json({ ok: true });
}));

app.put('/api/approval-levels/:id/toggle', auth(['admin']), h(async (req, res) => {
  const [[lvl]] = await pool.query('SELECT * FROM approval_levels WHERE id=?', [req.params.id]);
  if (!lvl) throw new HttpError(404, 'Approval level not found.');
  if (lvl.is_active) {
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM approval_levels WHERE is_active=1');
    if (n <= 1) throw new HttpError(400, 'At least one approval level must stay active.');
  }
  await pool.query('UPDATE approval_levels SET is_active = 1 - is_active WHERE id=?', [lvl.id]);
  res.json({ ok: true });
}));

// release (only an approved document)
app.post('/api/documents/:id/release', auth(['admin', 'clerk']), h(async (req, res) => {
  const released_to = text(req.body.released_to), remarks = text(req.body.remarks);
  if (!released_to) throw new HttpError(400, 'Enter who the document is released to.');
  maxLen(released_to, 150, 'Released to'); maxLen(remarks, 1000, 'Remarks');
  const releaseId = await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (doc.status !== 'Approved')
      throw new HttpError(400, 'Only an approved document can be released.');
    const [r] = await conn.query(
      'INSERT INTO releases (document_id, released_by, released_to, remarks) VALUES (?,?,?,?)',
      [doc.id, req.user.id, released_to.trim(), remarks || null]);
    await conn.query("UPDATE documents SET status='Released' WHERE id=?", [doc.id]);
    await track(conn, doc.id, 'Released', `Released to ${released_to.trim()} (${relNo(r.insertId, new Date().getFullYear())})`, req.user.id);
    await notify(conn, [doc.created_by, ...(await idsOf(conn, 'SELECT id FROM users WHERE department_id=? AND is_active=1', [doc.origin_dept_id]))],
      doc.id, `Released: ${doc.doc_number} was released to ${released_to.trim()}.`, req.user.id);
    return r.insertId;
  });
  res.json({ ok: true, release_id: releaseId });
}));

// WP19: release confirmation slip and release history
const relNo = (releaseId, year) => `REL-${year}-${String(releaseId).padStart(5, '0')}`;

app.get('/api/releases', auth(), h(async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const [rows] = await pool.query(
    `SELECT r.id, r.released_to, r.remarks, r.released_at, d.id document_id, d.doc_number, d.title, d.status,
            u.full_name released_by_name
     FROM releases r
     JOIN documents d ON d.id = r.document_id
     JOIN users u ON u.id = r.released_by
     WHERE d.doc_number LIKE ? OR d.title LIKE ? OR r.released_to LIKE ? OR u.full_name LIKE ?
     ORDER BY r.released_at DESC, r.id DESC`, [q, q, q, q]);
  res.json(rows.map((r) => ({ ...r, release_no: relNo(r.id, new Date(r.released_at).getFullYear()) })));
}));

app.get('/api/releases/:id/confirmation', auth(), h(async (req, res) => {
  const [[r]] = await pool.query(
    `SELECT r.id, r.released_to, r.remarks, r.released_at,
            d.doc_number, d.title, tp.name type_name, o.name origin_name,
            u.full_name released_by_name, ud.name released_by_dept,
            (SELECT MAX(a.decided_at) FROM approvals a WHERE a.document_id = d.id AND a.decision = 'Approved') approved_at
     FROM releases r
     JOIN documents d ON d.id = r.document_id
     JOIN document_types tp ON tp.id = d.type_id
     JOIN departments o ON o.id = d.origin_dept_id
     JOIN users u ON u.id = r.released_by
     JOIN departments ud ON ud.id = u.department_id
     WHERE r.id=?`, [req.params.id]);
  if (!r) throw new HttpError(404, 'Release record not found.');
  res.json({ ...r, release_no: relNo(r.id, new Date(r.released_at).getFullYear()) });
}));

// WP20: archive a released document (the last status)
app.post('/api/documents/:id/archive', auth(['admin', 'clerk']), h(async (req, res) => {
  await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (doc.status !== 'Released') throw new HttpError(400, 'Only a released document can be archived.');
    await conn.query("UPDATE documents SET status='Archived' WHERE id=?", [doc.id]);
    await track(conn, doc.id, 'Archived', `Archived by ${req.user.name}`, req.user.id);
  });
  res.json({ ok: true });
}));

// ---------- overdue & dashboard ----------
const overdueSql = `FROM routing r
  JOIN documents d ON d.id = r.document_id
  JOIN departments t ON t.id = r.to_dept_id
  WHERE r.status = 'Pending'
    AND (r.routed_at < NOW() - INTERVAL ${OVERDUE_DAYS} DAY OR r.due_date < CURDATE())`;

app.get('/api/overdue', auth(), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT d.id, d.doc_number, d.title, t.name to_name, r.routed_at,
            DATEDIFF(NOW(), r.routed_at) days_pending ${overdueSql} ORDER BY r.routed_at`);
  res.json({ days: OVERDUE_DAYS, rows });
}));

app.get('/api/dashboard', auth(), h(async (req, res) => {
  const [byStatus] = await pool.query('SELECT status, COUNT(*) count FROM documents GROUP BY status');
  const [byDept] = await pool.query(
    `SELECT o.name, COUNT(*) count FROM documents d
     JOIN departments o ON o.id = d.origin_dept_id GROUP BY o.name ORDER BY count DESC`);
  const [[{ total }]] = await pool.query('SELECT COUNT(*) total FROM documents');
  const [[{ overdue }]] = await pool.query(`SELECT COUNT(*) overdue ${overdueSql}`);

  // WP24: more charts
  const [byType] = await pool.query(
    `SELECT t.name, COUNT(*) count FROM documents d
     JOIN document_types t ON t.id = d.type_id GROUP BY t.name ORDER BY count DESC`);

  // documents registered in each of the last 6 months (months with none show 0)
  const [monthRows] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') ym, COUNT(*) count FROM documents
     WHERE created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 5 MONTH) GROUP BY ym`);
  const monthly = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    const hit = monthRows.find((r) => r.ym === ym);
    monthly.push({ ym, label: m.toLocaleString('en', { month: 'short' }), year: m.getFullYear(), count: hit ? Number(hit.count) : 0 });
  }

  // approval decisions per level (decisions made before the levels existed are shown on their own row)
  const [levelRows] = await pool.query(
    `SELECT l.level_no, l.name, COALESCE(SUM(a.decision = 'Approved'), 0) approved, COALESCE(SUM(a.decision = 'Rejected'), 0) rejected
     FROM approval_levels l LEFT JOIN approvals a ON a.level_id = l.id GROUP BY l.id, l.level_no, l.name ORDER BY l.level_no`);
  const [[older]] = await pool.query(
    `SELECT COALESCE(SUM(decision = 'Approved'), 0) approved, COALESCE(SUM(decision = 'Rejected'), 0) rejected
     FROM approvals WHERE level_id IS NULL`);
  const approval = levelRows.map((l) => ({ name: `Level ${l.level_no} - ${l.name}`, approved: Number(l.approved), rejected: Number(l.rejected) }));
  if (Number(older.approved) + Number(older.rejected))
    approval.push({ name: 'Before approval levels', approved: Number(older.approved), rejected: Number(older.rejected) });

  // how fast each department responds to documents routed to it
  const [routing] = await pool.query(
    `SELECT t.name, COUNT(r.id) routed, COALESCE(SUM(r.status = 'Pending'), 0) pending,
            COALESCE(SUM(r.status = 'Pending' AND (r.routed_at < NOW() - INTERVAL ${OVERDUE_DAYS} DAY OR r.due_date < CURDATE())), 0) overdue,
            ROUND(AVG(CASE WHEN r.received_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, r.routed_at, r.received_at) / 1440 END), 1) avg_days
     FROM routing r JOIN departments t ON t.id = r.to_dept_id GROUP BY t.id, t.name ORDER BY t.name`);

  const [[rel]] = await pool.query(
    `SELECT ROUND(AVG(TIMESTAMPDIFF(HOUR, d.created_at, r.released_at) / 24), 1) avg_days
     FROM releases r JOIN documents d ON d.id = r.document_id`);

  res.json({
    total, overdue, byStatus, byDept, byType, monthly, approval,
    routing: routing.map((r) => ({ name: r.name, routed: Number(r.routed), pending: Number(r.pending), overdue: Number(r.overdue),
      avg_days: r.avg_days === null ? null : Number(r.avg_days) })),
    release_avg_days: rel.avg_days === null ? null : Number(rel.avg_days),
  });
}));

// ---------- WP26: audit trail (admin only, read only: there is no way to edit or delete an entry) ----------
app.get('/api/audit', auth(['admin']), h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const action = String(req.query.action || '');
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  const where = [];
  const params = [];
  if (q) {
    where.push('(a.username LIKE ? OR u.full_name LIKE ? OR a.action LIKE ? OR a.details LIKE ? OR d.doc_number LIKE ?)');
    params.push(...Array(5).fill(`%${q}%`));
  }
  if (action) { where.push('a.action = ?'); params.push(action); }
  if (isDate(from)) { where.push('a.created_at >= ?'); params.push(from + ' 00:00:00'); }
  if (isDate(to)) { where.push('a.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(to); }
  const source = `FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN documents d ON d.id = a.document_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const all = req.query.export === '1'; // the CSV export gets up to 5000 rows at once
  const size = all ? 5000 : 50;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) total ${source}`, params);
  const pages = Math.max(1, Math.ceil(total / size));
  const page = all ? 1 : Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
  const [rows] = await pool.query(
    `SELECT a.id, a.created_at, a.action, a.details, a.document_id, d.doc_number, COALESCE(u.full_name, a.username) user_name, a.username
     ${source} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, size, (page - 1) * size]);
  const [acts] = await pool.query('SELECT DISTINCT action FROM audit_logs ORDER BY action');
  res.json({ rows, total: Number(total), page, pages, actions: acts.map((x) => x.action) });
}));

// ---------- WP22: notifications of the logged-in user ----------
// overdue notifications are created when someone loads their notifications (checked at most once a minute)
const SCAN_MS = Number(process.env.OVERDUE_SCAN_MS ?? 60000);
let lastOverdueScan = 0;
async function scanOverdue() {
  if (Date.now() - lastOverdueScan < SCAN_MS) return;
  lastOverdueScan = Date.now();
  const [rows] = await pool.query(`SELECT r.document_id, r.to_dept_id, r.routed_by, d.doc_number, t.name to_name ${overdueSql}`);
  for (const r of rows) {
    const msg = `Overdue: ${r.doc_number} has not been received by ${r.to_name}.`;
    const ids = [...new Set([...(await idsOf(pool, 'SELECT id FROM users WHERE department_id=? AND is_active=1', [r.to_dept_id])), r.routed_by])];
    for (const uid of ids)
      await pool.query(
        `INSERT INTO notifications (user_id, document_id, message)
         SELECT ?,?,? FROM DUAL
         WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id=? AND document_id=? AND message=?)`,
        [uid, r.document_id, msg, uid, r.document_id, msg]);
  }
}

app.get('/api/notifications', auth(), h(async (req, res) => {
  try { await scanOverdue(); } catch (e) { console.error('Overdue scan failed:', e.message); }
  const [rows] = await pool.query(
    'SELECT id, document_id, message, is_read, created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30', [req.user.id]);
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) unread FROM notifications WHERE user_id=? AND is_read=0', [req.user.id]);
  res.json({ unread, rows });
}));

app.put('/api/notifications/read-all', auth(), h(async (req, res) => {
  await pool.query('UPDATE notifications SET is_read=1 WHERE user_id=?', [req.user.id]);
  res.json({ ok: true });
}));

app.put('/api/notifications/:id/read', auth(), h(async (req, res) => {
  await pool.query('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

// ---------- WP23: reports (see reports.js) ----------
require('./reports')(app, { pool, auth, h, HttpError, OVERDUE_DAYS, relNo });

// ---------- start ----------
// Vercel imports this file and uses the exported app; `npm start` runs it directly.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  ready()
    .then(() => app.listen(PORT, () => console.log(`DTS running at http://localhost:${PORT}`)))
    .catch((e) => {
      console.error('Could not start. Check your .env database settings and that schema.sql was run.\n', e.message);
      process.exit(1);
    });
}

module.exports = app;
