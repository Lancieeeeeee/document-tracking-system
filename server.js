                                                                                                                                      require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const OVERDUE_DAYS = 3; // a routed document not received after this many days is overdue

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'dts_db',
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const h = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error: ' + e.message });
  });

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

// every action writes a tracking record
const track = (conn, docId, action, details, userId) =>
  conn.query(
    'INSERT INTO tracking_history (document_id, action, details, user_id) VALUES (?,?,?,?)',
    [docId, action, details, userId]
  );

async function getDoc(conn, id) {
  const [[doc]] = await conn.query('SELECT * FROM documents WHERE id=? FOR UPDATE', [id]);
  if (!doc) throw new HttpError(404, 'Document not found.');
  return doc;
}

// ---------- login sessions (kept in memory) ----------
const sessions = new Map();

function auth(roles = []) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = sessions.get(token);
    if (!user) return res.status(401).json({ error: 'Please log in.' });
    if (roles.length && !roles.includes(user.role))
      return res.status(403).json({ error: 'You are not allowed to do this.' });
    req.user = user;
    next();
  };
}

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
app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.query(
    'SELECT u.*, d.name dept_name FROM users u JOIN departments d ON d.id=u.department_id WHERE u.username=?',
    [username || '']
  );
  const u = rows[0];
  if (!u || !u.is_active || !(await bcrypt.compare(password || '', u.password_hash)))
    throw new HttpError(401, 'Invalid username or password.');
  const token = crypto.randomBytes(24).toString('hex');
  const user = { id: u.id, name: u.full_name, role: u.role, department_id: u.department_id, dept_name: u.dept_name };
  sessions.set(token, user);
  res.json({ token, user });
}));

app.post('/api/logout', auth(), h(async (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
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
  res.json({ departments, types, senders, receivers });
}));

app.post('/api/departments', auth(['admin']), h(async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Department name is required.');
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
  const name = (req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Department name is required.');
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
  const { employee_no, full_name, position, email, department_id } = req.body;
  if (!(employee_no || '').trim() || !(full_name || '').trim() || !department_id)
    throw new HttpError(400, 'Employee no., full name and department are required.');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  const vals = [employee_no.trim(), full_name.trim(), position || null, email || null, department_id];
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
  for (const [t, u] of sessions) if (u.id === Number(userId)) sessions.delete(t);
}

function checkPassword(pw) {
  if (!pw || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
}

async function checkUserFields({ full_name, role, department_id }) {
  if (!(full_name || '').trim() || !department_id) throw new HttpError(400, 'Full name and department are required.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a valid role.');
  const [[dept]] = await pool.query('SELECT * FROM departments WHERE id=?', [department_id]);
  if (!dept || !dept.is_active) throw new HttpError(400, 'Choose an active department.');
  return dept;
}

app.get('/api/users', auth(['admin']), h(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name, u.username, u.role, u.department_id, u.is_active, d.name dept_name
     FROM users u JOIN departments d ON d.id = u.department_id ORDER BY u.full_name`);
  res.json(rows);
}));

app.post('/api/users', auth(['admin']), h(async (req, res) => {
  const { full_name, username, password, role, department_id } = req.body;
  await checkUserFields(req.body);
  if (!/^[A-Za-z0-9._-]{3,50}$/.test((username || '').trim()))
    throw new HttpError(400, 'Username must be 3-50 characters: letters, numbers, dot, dash or underscore.');
  checkPassword(password);
  try {
    await pool.query(
      'INSERT INTO users (full_name, username, password_hash, role, department_id) VALUES (?,?,?,?,?)',
      [full_name.trim(), username.trim(), await bcrypt.hash(password, 10), role, department_id]);
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
  await pool.query('UPDATE users SET full_name=?, role=?, department_id=? WHERE id=?',
    [full_name.trim(), role, department_id, req.params.id]);
  if (isSelf) {
    req.user.name = full_name.trim();
    req.user.department_id = dept.id;
    req.user.dept_name = dept.name;
  } else {
    dropSessions(req.params.id); // they log in again to get the new role
  }
  res.json({ ok: true });
}));

app.put('/api/users/:id/toggle', auth(['admin']), h(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new HttpError(400, 'You cannot deactivate your own account.');
  await pool.query('UPDATE users SET is_active = 1 - is_active WHERE id=?', [req.params.id]);
  dropSessions(req.params.id);
  res.json({ ok: true });
}));

app.put('/api/users/:id/password', auth(['admin']), h(async (req, res) => {
  checkPassword(req.body.new_password);
  await pool.query('UPDATE users SET password_hash=? WHERE id=?',
    [await bcrypt.hash(req.body.new_password, 10), req.params.id]);
  if (Number(req.params.id) !== req.user.id) dropSessions(req.params.id);
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
  dropSessions(req.params.id);
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
  await pool.query('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(new_password, 10), req.user.id]);
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

// ---------- file uploads ----------
const UPLOAD_DIR = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'uploads') 
  : path.join(__dirname, 'uploads');

try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.error('Could not create upload directory:', err.message);
}
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
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
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // stored under a unique name; the original name is kept in the database
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = FILE_TYPES[ext] && (FILE_TYPES[ext].includes(file.mimetype) || file.mimetype === 'application/octet-stream');
    cb(ok ? null : new HttpError(400, TYPE_MESSAGE), !!ok);
  },
});

const removeFile = (name) => fs.unlink(path.join(UPLOAD_DIR, name), () => {});

function receiveFile(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(new HttpError(400, 'File is too large. The maximum size is 5 MB.'));
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
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  const head = buf.toString('latin1');
  let ok = false;
  if (ext === '.pdf') ok = head.startsWith('%PDF');
  else if (ext === '.docx' || ext === '.xlsx') ok = buf[0] === 0x50 && buf[1] === 0x4b;
  else if (ext === '.png') ok = buf[0] === 0x89 && head.slice(1, 4) === 'PNG';
  else if (ext === '.jpg' || ext === '.jpeg') ok = buf[0] === 0xff && buf[1] === 0xd8;
  else if (ext === '.gif') ok = head.startsWith('GIF8');
  else if (ext === '.webp') ok = head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WEBP';
  if (!ok) {
    removeFile(file.filename);
    throw new HttpError(400, 'The file content does not match its type.');
  }
}

const originalName = (file) => Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 255);

app.post('/api/documents/:id/files', auth(fileRoles), h(async (req, res) => {
  const file = await receiveFile(req, res);
  try {
    verifySignature(file);
    const name = originalName(file);
    await tx(async (conn) => {
      const doc = await getDoc(conn, req.params.id);
      if (doc.status === 'Released') throw new HttpError(400, 'Files cannot be changed after the document is released.');
      await conn.query(
        `INSERT INTO files (document_id, original_name, stored_name, file_type, file_size, uploaded_by)
         VALUES (?,?,?,?,?,?)`,
        [doc.id, name, file.filename, file.mimetype, file.size, req.user.id]);
      await track(conn, doc.id, 'File uploaded', name, req.user.id);
    });
  } catch (e) {
    removeFile(file.filename);
    throw e;
  }
  res.json({ ok: true });
}));

app.put('/api/files/:id', auth(fileRoles), h(async (req, res) => {
  const file = await receiveFile(req, res);
  let oldStored;
  try {
    verifySignature(file);
    const name = originalName(file);
    await tx(async (conn) => {
      const [[f]] = await conn.query(
        `SELECT f.*, d.status FROM files f JOIN documents d ON d.id = f.document_id WHERE f.id=? FOR UPDATE`, [req.params.id]);
      if (!f) throw new HttpError(404, 'File not found.');
      if (f.status === 'Released') throw new HttpError(400, 'Files cannot be changed after the document is released.');
      if (req.user.role === 'sender' && f.uploaded_by !== req.user.id)
        throw new HttpError(403, 'You can only replace files you uploaded.');
      await conn.query(
        `UPDATE files SET original_name=?, stored_name=?, file_type=?, file_size=?, uploaded_by=?, uploaded_at=NOW() WHERE id=?`,
        [name, file.filename, file.mimetype, file.size, req.user.id, f.id]);
      await track(conn, f.document_id, 'File replaced', `${f.original_name} -> ${name}`, req.user.id);
      oldStored = f.stored_name;
    });
  } catch (e) {
    removeFile(file.filename);
    throw e;
  }
  removeFile(oldStored);
  res.json({ ok: true });
}));

app.delete('/api/files/:id', auth(fileRoles), h(async (req, res) => {
  let stored;
  await tx(async (conn) => {
    const [[f]] = await conn.query(
      `SELECT f.*, d.status FROM files f JOIN documents d ON d.id = f.document_id WHERE f.id=? FOR UPDATE`, [req.params.id]);
    if (!f) throw new HttpError(404, 'File not found.');
    if (f.status === 'Released') throw new HttpError(400, 'Files cannot be changed after the document is released.');
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
  const { title, description, type_id, origin_dept_id, sender_id } = req.body;
  if (!title || !type_id || !origin_dept_id)
    throw new HttpError(400, 'Title, document type and origin department are required.');
  if (!sender_id) throw new HttpError(400, 'Choose a sender. Register senders first in Senders & Receivers.');
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
      [num, title.trim(), description || null, type_id, origin_dept_id, snd.id, req.user.id]
    );
    await track(conn, r.insertId, 'Registered', `Registered as ${num}`, req.user.id);
    return { id: r.insertId, doc_number: num };
  });
  res.json(result);
}));

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
    `SELECT a.*, u.full_name approver_name FROM approvals a
     JOIN users u ON u.id = a.approver_id WHERE a.document_id=? ORDER BY a.id`, [doc.id]);
  const [releases] = await pool.query(
    `SELECT r.*, u.full_name released_by_name FROM releases r
     JOIN users u ON u.id = r.released_by WHERE r.document_id=? ORDER BY r.id`, [doc.id]);
  const [history] = await pool.query(
    `SELECT h.*, u.full_name user_name FROM tracking_history h
     JOIN users u ON u.id = h.user_id WHERE h.document_id=? ORDER BY h.id`, [doc.id]);
  const [files] = await pool.query(
    `SELECT f.*, u.full_name uploaded_by_name FROM files f
     JOIN users u ON u.id = f.uploaded_by WHERE f.document_id=? ORDER BY f.id`, [doc.id]);
  res.json({ doc, routing, approvals, releases, files, history });
}));

// route a document to another department
app.post('/api/documents/:id/route', auth(), h(async (req, res) => {
  const { to_dept_id, receiver_id, due_date, purpose, instructions } = req.body;
  if (!to_dept_id) throw new HttpError(400, 'Choose a destination department.');
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
  });
  res.json({ ok: true });
}));

// receive or return a routed document
async function respondToRouting(req, res, action) {
  const remarks = (req.body.remarks || '').trim();
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
    await track(conn, r.document_id, action, remarks || `${action} by ${req.user.dept_name}`, req.user.id);
  });
  res.json({ ok: true });
}
app.post('/api/routing/:id/receive', auth(), h((req, res) => respondToRouting(req, res, 'Received')));
app.post('/api/routing/:id/return', auth(), h((req, res) => respondToRouting(req, res, 'Returned')));
app.post('/api/routing/:id/reject', auth(), h((req, res) => respondToRouting(req, res, 'Rejected')));

// approve or reject
app.post('/api/documents/:id/approve', auth(['admin', 'approver']), h(async (req, res) => {
  const { decision, comments } = req.body;
  if (!['Approved', 'Rejected'].includes(decision)) throw new HttpError(400, 'Invalid decision.');
  if (decision === 'Rejected' && !(comments || '').trim())
    throw new HttpError(400, 'Comments are required when rejecting a document.');
  await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (doc.status !== 'Received')
      throw new HttpError(400, 'Only a received document can be approved or rejected.');
    await conn.query(
      'INSERT INTO approvals (document_id, approver_id, decision, comments) VALUES (?,?,?,?)',
      [doc.id, req.user.id, decision, comments || null]);
    await conn.query('UPDATE documents SET status=? WHERE id=?', [decision, doc.id]);
    await track(conn, doc.id, decision, comments || `${decision} by ${req.user.name}`, req.user.id);
  });
  res.json({ ok: true });
}));

// release (only an approved document)
app.post('/api/documents/:id/release', auth(['admin', 'clerk']), h(async (req, res) => {
  const { released_to, remarks } = req.body;
  if (!(released_to || '').trim()) throw new HttpError(400, 'Enter who the document is released to.');
  await tx(async (conn) => {
    const doc = await getDoc(conn, req.params.id);
    if (doc.status !== 'Approved')
      throw new HttpError(400, 'Only an approved document can be released.');
    await conn.query(
      'INSERT INTO releases (document_id, released_by, released_to, remarks) VALUES (?,?,?,?)',
      [doc.id, req.user.id, released_to.trim(), remarks || null]);
    await conn.query("UPDATE documents SET status='Released' WHERE id=?", [doc.id]);
    await track(conn, doc.id, 'Released', `Released to ${released_to.trim()}`, req.user.id);
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
  res.json({ total, overdue, byStatus, byDept });
}));

// ---------- start ----------
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {
  seedUsers()
    .then(() => app.listen(PORT, () => console.log(`DTS running at http://localhost:${PORT}`)))
    .catch((e) => {
      console.error('Could not start. Check your .env database settings and that schema.sql was run.\n', e.message);
      process.exit(1);
    });
}

module.exports = app;
