// WP23: Reports Suite (document inventory, routing, approval, release, tracking and performance)
module.exports = function mountReports(app, { pool, auth, h, HttpError, OVERDUE_DAYS, relNo }) {
  const ROLES = ['admin', 'clerk', 'approver'];
  const STATUSES = ['Registered', 'Routed', 'Received', 'Returned', 'Approved', 'Rejected', 'Released', 'Archived'];
  const LIMIT = 5000;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const count = (rows, fn) => rows.filter(fn).length;
  const average = (values) => {
    const v = values.filter((x) => x !== null && !Number.isNaN(x));
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };

  // adds "date between from and to" to a WHERE clause (the "to" day is included)
  function between(column, q, params) {
    let sql = '';
    if (q.from) { sql += ` AND ${column} >= ?`; params.push(q.from); }
    if (q.to) { sql += ` AND ${column} < DATE_ADD(?, INTERVAL 1 DAY)`; params.push(q.to); }
    return sql;
  }

  const REPORTS = {
    // 1. every document with its status and where it was last sent
    async inventory(q) {
      const params = [];
      let where = between('d.created_at', q, params);
      if (q.dept) { where += ' AND d.origin_dept_id = ?'; params.push(q.dept); }
      if (q.status) { where += ' AND d.status = ?'; params.push(q.status); }
      if (q.type) { where += ' AND d.type_id = ?'; params.push(q.type); }
      const [rows] = await pool.query(
        `SELECT d.doc_number, d.title, t.name type_name, o.name origin_name,
                CONCAT(se.employee_no, ' - ', se.full_name) sender_name, d.status, d.created_at,
                DATEDIFF(NOW(), d.created_at) age_days,
                (SELECT dp.name FROM routing r JOIN departments dp ON dp.id = r.to_dept_id
                 WHERE r.document_id = d.id ORDER BY r.id DESC LIMIT 1) last_routed_to
         FROM documents d
         JOIN document_types t ON t.id = d.type_id
         JOIN departments o ON o.id = d.origin_dept_id
         LEFT JOIN senders sn ON sn.id = d.sender_id
         LEFT JOIN employees se ON se.id = sn.employee_id
         WHERE 1=1 ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${LIMIT}`, params);
      return {
        title: 'Document Inventory Report',
        columns: [
          { key: 'doc_number', label: 'Number' }, { key: 'title', label: 'Title' }, { key: 'type_name', label: 'Type' },
          { key: 'origin_name', label: 'Origin' }, { key: 'sender_name', label: 'Sender' }, { key: 'status', label: 'Status' },
          { key: 'created_at', label: 'Registered', kind: 'date' }, { key: 'age_days', label: 'Age (days)', kind: 'num' },
          { key: 'last_routed_to', label: 'Last routed to' },
        ],
        rows,
        summary: [{ label: 'Total documents', value: rows.length },
          ...STATUSES.map((s) => ({ label: s, value: count(rows, (r) => r.status === s) })).filter((x) => x.value)],
      };
    },

    // 2. every routing (document sent from one department to another)
    async routing(q) {
      const params = [];
      let where = between('r.routed_at', q, params);
      if (q.dept) { where += ' AND (r.from_dept_id = ? OR r.to_dept_id = ?)'; params.push(q.dept, q.dept); }
      const [rows] = await pool.query(
        `SELECT d.doc_number, d.title, f.name from_name, t.name to_name,
                CONCAT(e.employee_no, ' - ', e.full_name) receiver_name, r.purpose, r.status,
                r.routed_at, r.received_at,
                ROUND(TIMESTAMPDIFF(MINUTE, r.routed_at, r.received_at) / 1440, 1) days_to_respond
         FROM routing r
         JOIN documents d ON d.id = r.document_id
         JOIN departments f ON f.id = r.from_dept_id
         JOIN departments t ON t.id = r.to_dept_id
         LEFT JOIN receivers rv ON rv.id = r.receiver_id
         LEFT JOIN employees e ON e.id = rv.employee_id
         WHERE 1=1 ${where} ORDER BY r.routed_at DESC, r.id DESC LIMIT ${LIMIT}`, params);
      rows.forEach((r) => { r.days_to_respond = num(r.days_to_respond); });
      return {
        title: 'Routing Report',
        columns: [
          { key: 'doc_number', label: 'Number' }, { key: 'title', label: 'Title' }, { key: 'from_name', label: 'From' },
          { key: 'to_name', label: 'To' }, { key: 'receiver_name', label: 'Assigned receiver' }, { key: 'purpose', label: 'Purpose' },
          { key: 'status', label: 'Status' }, { key: 'routed_at', label: 'Routed', kind: 'date' },
          { key: 'received_at', label: 'Responded', kind: 'date' }, { key: 'days_to_respond', label: 'Days to respond', kind: 'num' },
        ],
        rows,
        summary: [{ label: 'Total routings', value: rows.length },
          ...['Pending', 'Received', 'Returned', 'Rejected'].map((s) => ({ label: s, value: count(rows, (r) => r.status === s) })),
          { label: 'Average days to respond', value: average(rows.map((r) => r.days_to_respond)) ?? '-' }],
      };
    },

    // 3. every approval decision, level by level
    async approval(q) {
      const params = [];
      let where = between('a.decided_at', q, params);
      if (q.dept) { where += ' AND d.origin_dept_id = ?'; params.push(q.dept); }
      const [rows] = await pool.query(
        `SELECT d.doc_number, d.title, l.level_no, CONCAT('Level ', l.level_no, ' - ', l.name) level_name,
                u.full_name approver_name, a.decision, a.comments, a.decided_at
         FROM approvals a
         JOIN documents d ON d.id = a.document_id
         JOIN users u ON u.id = a.approver_id
         LEFT JOIN approval_levels l ON l.id = a.level_id
         WHERE 1=1 ${where} ORDER BY a.decided_at DESC, a.id DESC LIMIT ${LIMIT}`, params);
      const [[{ waiting }]] = await pool.query("SELECT COUNT(*) waiting FROM documents WHERE status = 'Received'");
      const levels = [...new Set(rows.filter((r) => r.level_no).map((r) => r.level_name))].sort();
      return {
        title: 'Approval Report',
        columns: [
          { key: 'doc_number', label: 'Number' }, { key: 'title', label: 'Title' }, { key: 'level_name', label: 'Level' },
          { key: 'approver_name', label: 'Approver' }, { key: 'decision', label: 'Decision' }, { key: 'comments', label: 'Comments' },
          { key: 'decided_at', label: 'Date', kind: 'date' },
        ],
        rows: rows.map((r) => ({ ...r, level_name: r.level_name || 'Before approval levels' })),
        summary: [{ label: 'Total decisions', value: rows.length },
          { label: 'Approved', value: count(rows, (r) => r.decision === 'Approved') },
          { label: 'Rejected', value: count(rows, (r) => r.decision === 'Rejected') },
          ...levels.map((l) => ({ label: l, value: count(rows, (r) => r.level_name === l) })),
          { label: 'Documents waiting for approval now', value: Number(waiting) }],
      };
    },

    // 4. every release of a document
    async release(q) {
      const params = [];
      let where = between('r.released_at', q, params);
      if (q.dept) { where += ' AND d.origin_dept_id = ?'; params.push(q.dept); }
      const [rows] = await pool.query(
        `SELECT r.id, d.doc_number, d.title, o.name origin_name, r.released_to, u.full_name released_by_name, r.released_at, r.remarks
         FROM releases r
         JOIN documents d ON d.id = r.document_id
         JOIN departments o ON o.id = d.origin_dept_id
         JOIN users u ON u.id = r.released_by
         WHERE 1=1 ${where} ORDER BY r.released_at DESC, r.id DESC LIMIT ${LIMIT}`, params);
      rows.forEach((r) => { r.release_no = relNo(r.id, new Date(r.released_at).getFullYear()); });
      return {
        title: 'Release Report',
        columns: [
          { key: 'release_no', label: 'Release no.' }, { key: 'doc_number', label: 'Number' }, { key: 'title', label: 'Title' },
          { key: 'origin_name', label: 'Origin' }, { key: 'released_to', label: 'Released to' },
          { key: 'released_by_name', label: 'Released by' }, { key: 'released_at', label: 'Date', kind: 'date' },
          { key: 'remarks', label: 'Remarks' },
        ],
        rows,
        summary: [{ label: 'Total releases', value: rows.length },
          { label: 'Different recipients', value: new Set(rows.map((r) => r.released_to.toLowerCase())).size }],
      };
    },

    // 5. how fast each department handles documents, and how long a document takes from registration to release
    async performance(q) {
      const params = [];
      let join = between('r.routed_at', q, params);
      let where = '';
      if (q.dept) { where = ' WHERE dp.id = ?'; params.push(q.dept); }
      const [rows] = await pool.query(
        `SELECT dp.name department, COUNT(r.id) routed_in,
                COALESCE(SUM(r.status = 'Pending'), 0) pending,
                COALESCE(SUM(r.status = 'Received'), 0) received,
                COALESCE(SUM(r.status IN ('Returned', 'Rejected')), 0) returned_rejected,
                COALESCE(SUM(r.status = 'Pending' AND (r.routed_at < NOW() - INTERVAL ${OVERDUE_DAYS} DAY OR r.due_date < CURDATE())), 0) overdue,
                ROUND(AVG(CASE WHEN r.received_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, r.routed_at, r.received_at) / 1440 END), 1) avg_days
         FROM departments dp
         LEFT JOIN routing r ON r.to_dept_id = dp.id ${join}
         ${where} GROUP BY dp.id, dp.name ORDER BY dp.name`, params);
      rows.forEach((r) => ['routed_in', 'pending', 'received', 'returned_rejected', 'overdue', 'avg_days'].forEach((k) => { r[k] = num(r[k]); }));

      const dparams = [];
      const dateWhere = between('d.created_at', q, dparams);
      const [[reg]] = await pool.query(`SELECT COUNT(*) n FROM documents d WHERE 1=1 ${dateWhere}`, dparams);
      const rparams = [];
      const relWhere = between('r.released_at', q, rparams);
      const [[rel]] = await pool.query(
        `SELECT COUNT(*) n, ROUND(AVG(TIMESTAMPDIFF(HOUR, d.created_at, r.released_at) / 24), 1) avg_days
         FROM releases r JOIN documents d ON d.id = r.document_id WHERE 1=1 ${relWhere}`, rparams);
      return {
        title: 'Tracking and Performance Report',
        columns: [
          { key: 'department', label: 'Department' }, { key: 'routed_in', label: 'Documents routed in', kind: 'num' },
          { key: 'pending', label: 'Pending', kind: 'num' }, { key: 'received', label: 'Received', kind: 'num' },
          { key: 'returned_rejected', label: 'Returned or rejected', kind: 'num' }, { key: 'overdue', label: 'Overdue now', kind: 'num' },
          { key: 'avg_days', label: 'Average days to respond', kind: 'num' },
        ],
        rows,
        summary: [{ label: 'Documents registered', value: Number(reg.n) },
          { label: 'Documents released', value: Number(rel.n) },
          { label: 'Average days from registration to release', value: num(rel.avg_days) ?? '-' },
          { label: 'Overdue documents now', value: rows.reduce((a, r) => a + r.overdue, 0) }],
      };
    },
  };

  app.get('/api/reports/:type', auth(ROLES), h(async (req, res) => {
    const run = REPORTS[req.params.type];
    if (!run) throw new HttpError(404, 'Unknown report.');
    const q = {
      from: String(req.query.from || ''), to: String(req.query.to || ''),
      dept: Number(req.query.dept) || 0, type: Number(req.query.type) || 0, status: String(req.query.status || ''),
    };
    if ((q.from && !isDate(q.from)) || (q.to && !isDate(q.to))) throw new HttpError(400, 'Enter valid dates.');
    if (q.from && q.to && q.from > q.to) throw new HttpError(400, 'The "from" date cannot be later than the "to" date.');
    if (q.status && !STATUSES.includes(q.status)) throw new HttpError(400, 'Unknown status.');
    res.json(await run(q));
  }));
};
