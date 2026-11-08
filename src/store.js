// Shared data layer used by BOTH the Electron app and the MCP server.
// Data lives in a single JSON file so the two processes always see the same state.
// Writes are atomic (tmp file + rename) and serialized with a lock file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DATA_DIR = process.env.TASKFLOW_DATA_DIR || path.join(os.homedir(), '.taskflow');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_DOC_BYTES = 200 * 1024 * 1024;
const LOCK_FILE = DATA_FILE + '.lock';

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];
const STATUS_LABELS = { todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' };
const TYPES = ['task', 'bug', 'story', 'epic'];
const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function seed() {
  const projectId = uid();
  const sprintId = uid();
  const t = now();
  const mk = (n, o) => ({
    id: uid(), key: `DEMO-${n}`, projectId, type: 'task', title: '', description: '',
    status: 'todo', priority: 'medium', assignee: null, reporter: 'Me', labels: [],
    storyPoints: null, epicId: null, sprintId: null, dueDate: null,
    createdAt: t, updatedAt: t, order: n, ...o,
  });
  const epic = mk(1, { type: 'epic', title: 'User onboarding', description: 'Everything related to the first-run experience.' });
  const issues = [
    epic,
    mk(2, { type: 'story', title: 'Sign-up form with email verification', status: 'in_progress', priority: 'high', assignee: 'Alex', storyPoints: 5, epicId: epic.id, sprintId, labels: ['frontend'] }),
    mk(3, { type: 'bug', title: 'Password reset link expires too early', status: 'todo', priority: 'highest', assignee: 'Sam', storyPoints: 2, sprintId, labels: ['auth'] }),
    mk(4, { type: 'task', title: 'Write welcome email copy', status: 'in_review', priority: 'medium', assignee: 'Jordan', storyPoints: 1, epicId: epic.id, sprintId }),
    mk(5, { type: 'task', title: 'Set up CI pipeline', status: 'done', priority: 'low', assignee: 'Alex', storyPoints: 3, sprintId, labels: ['devops'] }),
    mk(6, { type: 'story', title: 'Product tour for new users', priority: 'medium', storyPoints: 8, epicId: epic.id }),
    mk(7, { type: 'bug', title: 'Avatar upload fails for PNG > 2MB', priority: 'high' }),
  ];
  return {
    version: 1,
    users: ['Me', 'Alex', 'Sam', 'Jordan'],
    projects: [{ id: projectId, key: 'DEMO', name: 'Demo Project', description: 'A sample project to get you started.', lead: 'Me', issueCounter: issues.length, createdAt: t }],
    sprints: [{ id: sprintId, projectId, name: 'DEMO Sprint 1', goal: 'Ship the sign-up flow', state: 'active', startDate: t, endDate: null, createdAt: t }],
    issues,
    comments: [{ id: uid(), issueId: issues[2].id, author: 'Sam', body: 'Repro: request reset, wait 5 minutes, link is dead.', createdAt: t }],
  };
}

function read() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = seed();
    writeAtomic(data);
    return data;
  }
}

function writeAtomic(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function withLock(fn) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const start = Date.now();
  let fd;
  while (true) {
    try { fd = fs.openSync(LOCK_FILE, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { // break stale locks (crashed process)
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 5000) { fs.unlinkSync(LOCK_FILE); continue; }
      } catch { continue; }
      if (Date.now() - start > 10000) throw new Error('Timed out waiting for data lock');
      sleepSync(15);
    }
  }
  try { return fn(); } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

// Read-modify-write under lock. fn receives fresh data and returns a result.
function mutate(fn) {
  return withLock(() => {
    const data = read();
    const result = fn(data);
    writeAtomic(data);
    return result;
  });
}

// ---------- lookups ----------
function findProject(data, ref) {
  if (!ref) throw new Error('Project is required');
  const r = String(ref).toLowerCase();
  const p = data.projects.find(p => p.id === ref || p.key.toLowerCase() === r || p.name.toLowerCase() === r);
  if (!p) throw new Error(`Project not found: ${ref}`);
  return p;
}
function findIssue(data, ref) {
  const r = String(ref).toUpperCase();
  const i = data.issues.find(i => i.id === ref || i.key.toUpperCase() === r);
  if (!i) throw new Error(`Issue not found: ${ref}`);
  return i;
}
function findSprint(data, ref, projectId) {
  const r = String(ref).toLowerCase();
  const s = data.sprints.find(s => (s.id === ref || s.name.toLowerCase() === r) && (!projectId || s.projectId === projectId));
  if (!s) throw new Error(`Sprint not found: ${ref}`);
  return s;
}
function normStatus(s) {
  if (!s) return s;
  const v = String(s).toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (STATUSES.includes(v)) return v;
  if (v === 'to_do' || v === 'open' || v === 'backlog') return 'todo';
  if (v === 'review' || v === 'code_review') return 'in_review';
  if (v === 'closed' || v === 'resolved' || v === 'complete' || v === 'completed') return 'done';
  throw new Error(`Invalid status "${s}". Use one of: ${STATUSES.join(', ')}`);
}
function check(val, list, name) {
  if (val == null) return val;
  const v = String(val).toLowerCase();
  if (!list.includes(v)) throw new Error(`Invalid ${name} "${val}". Use one of: ${list.join(', ')}`);
  return v;
}
function ensureUser(data, name) {
  if (name && !data.users.includes(name)) data.users.push(name);
}

// ---------- API ----------
const api = {
  getAll: () => read(),

  createProject({ key, name, description = '', lead = 'Me' }) {
    return mutate(data => {
      key = String(key || '').toUpperCase().trim();
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new Error('Project key must be 2-10 letters/digits, starting with a letter');
      if (data.projects.some(p => p.key === key)) throw new Error(`Project key ${key} already exists`);
      if (!name) throw new Error('Project name is required');
      const p = { id: uid(), key, name, description, lead, issueCounter: 0, createdAt: now() };
      data.projects.push(p);
      return p;
    });
  },

  updateProject(ref, patch) {
    return mutate(data => {
      const p = findProject(data, ref);
      for (const k of ['name', 'description', 'lead']) if (patch[k] !== undefined) p[k] = patch[k];
      return p;
    });
  },

  deleteProject(ref) {
    return mutate(data => {
      const p = findProject(data, ref);
      const ids = new Set(data.issues.filter(i => i.projectId === p.id).map(i => i.id));
      data.issues = data.issues.filter(i => i.projectId !== p.id);
      data.comments = data.comments.filter(c => !ids.has(c.issueId));
      data.sprints = data.sprints.filter(s => s.projectId !== p.id);
      data.projects = data.projects.filter(x => x.id !== p.id);
      if (data.syncState) delete data.syncState[p.id];
      data.documents = (data.documents || []).filter(d => d.projectId !== p.id);
      fs.rmSync(path.join(FILES_DIR, p.id), { recursive: true, force: true });
      return { deleted: p.key };
    });
  },

  createIssue(input) {
    return mutate(data => {
      const p = findProject(data, input.project || input.projectId);
      if (!input.title || !String(input.title).trim()) throw new Error('Title is required');
      p.issueCounter += 1;
      const t = now();
      const issue = {
        id: uid(), key: `${p.key}-${p.issueCounter}`, projectId: p.id,
        type: check(input.type || 'task', TYPES, 'type'),
        title: String(input.title).trim(),
        description: input.description || '',
        status: normStatus(input.status || 'todo'),
        priority: check(input.priority || 'medium', PRIORITIES, 'priority'),
        assignee: input.assignee || null,
        reporter: input.reporter || 'Me',
        labels: input.labels || [],
        storyPoints: input.storyPoints ?? null,
        epicId: input.epic ? findIssue(data, input.epic).id : (input.epicId || null),
        sprintId: input.sprint ? findSprint(data, input.sprint, p.id).id : (input.sprintId || null),
        dueDate: input.dueDate || null,
        createdAt: t, updatedAt: t,
        order: Math.max(0, ...data.issues.map(i => i.order || 0)) + 1,
      };
      ensureUser(data, issue.assignee);
      data.issues.push(issue);
      return issue;
    });
  },

  updateIssue(ref, patch) {
    return mutate(data => {
      const i = findIssue(data, ref);
      if (patch.title !== undefined) { if (!String(patch.title).trim()) throw new Error('Title cannot be empty'); i.title = String(patch.title).trim(); }
      if (patch.description !== undefined) i.description = patch.description;
      if (patch.status !== undefined) i.status = normStatus(patch.status);
      if (patch.type !== undefined) i.type = check(patch.type, TYPES, 'type');
      if (patch.priority !== undefined) i.priority = check(patch.priority, PRIORITIES, 'priority');
      if (patch.assignee !== undefined) { i.assignee = patch.assignee || null; ensureUser(data, i.assignee); }
      if (patch.reporter !== undefined) i.reporter = patch.reporter;
      if (patch.labels !== undefined) i.labels = patch.labels;
      if (patch.storyPoints !== undefined) i.storyPoints = patch.storyPoints === '' ? null : patch.storyPoints;
      if (patch.dueDate !== undefined) i.dueDate = patch.dueDate || null;
      if (patch.order !== undefined) i.order = patch.order;
      if (patch.epic !== undefined) i.epicId = patch.epic ? findIssue(data, patch.epic).id : null;
      if (patch.epicId !== undefined) i.epicId = patch.epicId || null;
      if (patch.sprint !== undefined) i.sprintId = patch.sprint ? findSprint(data, patch.sprint, i.projectId).id : null;
      if (patch.sprintId !== undefined) i.sprintId = patch.sprintId || null;
      i.updatedAt = now();
      return i;
    });
  },

  deleteIssue(ref) {
    return mutate(data => {
      const i = findIssue(data, ref);
      data.issues = data.issues.filter(x => x.id !== i.id);
      data.comments = data.comments.filter(c => c.issueId !== i.id);
      data.issues.forEach(x => { if (x.epicId === i.id) x.epicId = null; });
      return { deleted: i.key };
    });
  },

  addComment(ref, body, author = 'Me') {
    return mutate(data => {
      const i = findIssue(data, ref);
      if (!body || !String(body).trim()) throw new Error('Comment body is required');
      const c = { id: uid(), issueId: i.id, author, body: String(body), createdAt: now() };
      data.comments.push(c);
      i.updatedAt = now();
      return c;
    });
  },

  deleteComment(id) {
    return mutate(data => {
      data.comments = data.comments.filter(c => c.id !== id);
      return { deleted: id };
    });
  },

  createSprint({ project, name, goal = '' }) {
    return mutate(data => {
      const p = findProject(data, project);
      const n = data.sprints.filter(s => s.projectId === p.id).length + 1;
      const s = { id: uid(), projectId: p.id, name: name || `${p.key} Sprint ${n}`, goal, state: 'planned', startDate: null, endDate: null, createdAt: now() };
      data.sprints.push(s);
      return s;
    });
  },

  updateSprint(ref, patch) {
    return mutate(data => {
      const s = findSprint(data, ref);
      if (patch.name !== undefined && String(patch.name).trim()) s.name = String(patch.name).trim();
      if (patch.goal !== undefined) s.goal = patch.goal;
      return s;
    });
  },

  startSprint(ref) {
    return mutate(data => {
      const s = findSprint(data, ref);
      if (data.sprints.some(x => x.projectId === s.projectId && x.state === 'active')) throw new Error('This project already has an active sprint. Complete it first.');
      if (s.state !== 'planned') throw new Error(`Sprint is ${s.state}`);
      s.state = 'active'; s.startDate = now();
      return s;
    });
  },

  completeSprint(ref) {
    return mutate(data => {
      const s = findSprint(data, ref);
      if (s.state !== 'active') throw new Error('Only an active sprint can be completed');
      s.state = 'completed'; s.endDate = now();
      let moved = 0;
      data.issues.forEach(i => { if (i.sprintId === s.id && i.status !== 'done') { i.sprintId = null; moved++; } });
      return { ...s, incompleteMovedToBacklog: moved };
    });
  },

  deleteSprint(ref) {
    return mutate(data => {
      const s = findSprint(data, ref);
      data.issues.forEach(i => { if (i.sprintId === s.id) i.sprintId = null; });
      data.sprints = data.sprints.filter(x => x.id !== s.id);
      return { deleted: s.name };
    });
  },

  addUser(name) {
    return mutate(data => { ensureUser(data, name); return data.users; });
  },

  // ---------- project documents (PDF) ----------
  // The file is copied into ~/.taskflow/files/<projectId>/<docId>.pdf, so the original can be moved or deleted.
  addDocument({ project, filePath, name, uploadedBy = 'Me' }) {
    if (!filePath) throw new Error('No file given');
    const src = path.resolve(String(filePath));
    let st;
    try { st = fs.statSync(src); } catch { throw new Error(`File not found: ${src}`); }
    if (!st.isFile()) throw new Error('Not a file');
    if (st.size > MAX_DOC_BYTES) throw new Error(`File is too large (max ${MAX_DOC_BYTES / 1024 / 1024} MB)`);
    const head = Buffer.alloc(5);
    const fd = fs.openSync(src, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd);
    if (head.toString('latin1') !== '%PDF-') throw new Error(`${path.basename(src)} is not a PDF file`);
    const fileName = path.basename(src);
    const docName = String(name || '').trim() || fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim();
    const id = uid();
    // Copy outside the data lock (files can be large), then register it.
    const data0 = read();
    const p0 = findProject(data0, project);
    const dest = path.join(FILES_DIR, p0.id, `${id}.pdf`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    try {
      return mutate(data => {
        const p = findProject(data, p0.id);
        data.documents = data.documents || [];
        if (data.documents.some(d => d.projectId === p.id && d.name.toLowerCase() === docName.toLowerCase())) throw new Error(`A document named "${docName}" already exists in ${p.key}`);
        const doc = { id, projectId: p.id, name: docName, fileName, size: st.size, uploadedBy, createdAt: now() };
        data.documents.push(doc);
        return doc;
      });
    } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
  },

  renameDocument(id, name) {
    return mutate(data => {
      const d = (data.documents || []).find(x => x.id === id);
      if (!d) throw new Error('Document not found');
      const n = String(name || '').trim();
      if (!n) throw new Error('Name cannot be empty');
      if (data.documents.some(x => x.id !== id && x.projectId === d.projectId && x.name.toLowerCase() === n.toLowerCase())) throw new Error(`A document named "${n}" already exists`);
      d.name = n;
      return d;
    });
  },

  deleteDocument(id) {
    return mutate(data => {
      const d = (data.documents || []).find(x => x.id === id);
      if (!d) throw new Error('Document not found');
      data.documents = data.documents.filter(x => x.id !== id);
      fs.rmSync(documentPath(d), { force: true });
      return { deleted: d.name };
    });
  },

  // Removes a person from the shared people list and unassigns their open work.
  removeUser(name) {
    return mutate(data => {
      if (!data.users.includes(name)) throw new Error(`Person not found: ${name}`);
      if (name === 'Me') throw new Error('You cannot remove yourself ("Me")');
      data.users = data.users.filter(u => u !== name);
      let unassigned = 0;
      data.issues.forEach(i => { if (i.assignee === name) { i.assignee = null; i.updatedAt = now(); unassigned++; } });
      data.projects.forEach(p => { if (p.lead === name) p.lead = 'Me'; });
      return { removed: name, unassigned };
    });
  },
};

function documentPath(doc) { return path.join(FILES_DIR, doc.projectId, `${doc.id}.pdf`); }

module.exports = { api, read, mutateData: mutate, documentPath, FILES_DIR, findProject, findIssue, findSprint, DATA_FILE, DATA_DIR, STATUSES, STATUS_LABELS, TYPES, PRIORITIES };
