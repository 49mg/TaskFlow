/* TaskFlow renderer — vanilla JS, no build step. */
'use strict';

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];
const STATUS_LABELS = { todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' };
const TYPES = ['task', 'bug', 'story', 'epic'];
const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const S = {
  data: null,
  projectId: store.get('projectId', null),
  view: store.get('view', 'board'),
  board: { q: '', assignees: new Set(), type: '' },
  list: { q: '', status: '', type: '', priority: '', assignee: '', sort: 'key', dir: -1 },
  collapsed: new Set(store.get('collapsed', [])),
  openIssueId: null,
  modalKind: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- data access ----------------
async function call(method, ...args) {
  try { return await window.taskflow.call(method, ...args); }
  catch (e) { toast(e.message, true); throw e; }
}
async function load() {
  S.data = await window.taskflow.call('getAll');
  if (!S.data.projects.find(p => p.id === S.projectId)) S.projectId = S.data.projects[0]?.id || null;
  render();
}
async function mutate(method, ...args) {
  const r = await call(method, ...args);
  await load();
  return r;
}
window.taskflow.onDataChanged(() => load());

const project = () => S.data.projects.find(p => p.id === S.projectId);
const issueById = (id) => S.data.issues.find(i => i.id === id);
const projectIssues = () => S.data.issues.filter(i => i.projectId === S.projectId);
const projectSprints = () => S.data.sprints.filter(s => s.projectId === S.projectId);
const activeSprint = () => projectSprints().find(s => s.state === 'active');
const epics = () => projectIssues().filter(i => i.type === 'epic');
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

// ---------------- visual helpers ----------------
const PALETTE = ['#2A835F', '#12544F', '#E56910', '#6E5DC6', '#C9372C', '#2898BD', '#943D73', '#5B7F24', '#B38600', '#AE4787'];
const colorFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const PROJ_PALETTE = ["#2A835F", "#12544F", "#3E7C74", "#5A8F63", "#1F6B6B", "#0F4C4A"];
const projColor = (k) => { let h = 0; for (const c of String(k)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PROJ_PALETTE[h % PROJ_PALETTE.length]; };
const initials = (n) => String(n).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || '?';
function avatar(name, cls = '') {
  if (!name) return `<span class="avatar empty ${cls}" title="Unassigned"><svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5Z"/></svg></span>`;
  return `<span class="avatar ${cls}" style="background:${colorFor(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;
}
function typeIcon(t) {
  const icons = {
    task: '<svg class="ticon" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#4BADE8"/><path d="M4.5 8.2 7 10.5l4.5-5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bug: '<svg class="ticon" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#E5493A"/><circle cx="8" cy="8" r="3.5" fill="#fff"/></svg>',
    story: '<svg class="ticon" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#63BA3C"/><path d="M5 3.5h6v9l-3-2.2-3 2.2z" fill="#fff"/></svg>',
    epic: '<svg class="ticon" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#904EE2"/><path d="M9 3 5 9h3l-1 4 4-6H8z" fill="#fff"/></svg>',
  };
  return `<span title="${cap(t)}">${icons[t] || icons.task}</span>`;
}
function priorityIcon(p) {
  const m = {
    highest: ['#C9372C', 'M3 9l5-5 5 5M3 13l5-5 5 5'], high: ['#E2483D', 'M3 11l5-5 5 5'],
    medium: ['#E2B203', 'M3 6h10M3 10h10'], low: ['#8BBB92', 'M3 5l5 5 5-5'], lowest: ['#2A835F', 'M3 3l5 5 5-5M3 7l5 5 5-5'],
  }[p] || ['#E2B203', 'M3 6h10M3 10h10'];
  return `<svg class="picon" viewBox="0 0 16 16" title="${cap(p)}"><title>${cap(p)} priority</title><path d="${m[1]}" stroke="${m[0]}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
const lozenge = (s) => `<span class="lozenge lz-${s}">${STATUS_LABELS[s]}</span>`;
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  const ago = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return ago(Math.floor(s / 60), 'minute');
  if (s < 86400) return ago(Math.floor(s / 3600), 'hour');
  if (s < 86400 * 7) return ago(Math.floor(s / 86400), 'day');
  return fmtDate(iso);
}
function miniMarkdown(text) {
  const lines = esc(text).split('\n');
  let out = '', inList = false;
  for (const raw of lines) {
    let l = raw
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank">$1</a>');
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${li[1]}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    const hd = l.match(/^#{1,3}\s+(.*)/);
    out += hd ? `<b>${hd[1]}</b><br>` : `${l}<br>`;
  }
  if (inList) out += '</ul>';
  return out;
}
function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = error
    ? '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-2 15-5-5 1.4-1.4 3.6 3.6 7.6-7.6L19 8l-9 9Z"/></svg>';
  el.append(document.createTextNode(msg));
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, error ? 5000 : 2500);
}
// Due-date chip: red when overdue, amber when due within 2 days.
function dueChip(i) {
  if (!i.dueDate || i.status === 'done') return '';
  const days = Math.round((new Date(i.dueDate + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
  const cls = days < 0 ? 'overdue' : days <= 2 ? 'soon' : '';
  const label = days < 0 ? `${-days}d overdue` : days === 0 ? 'Due today' : days === 1 ? 'Tomorrow' : new Date(i.dueDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<span class="due-chip ${cls}" title="Due ${esc(i.dueDate)}"><svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 16H5V9h14v11Z"/></svg>${label}</span>`;
}
const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

// ---------------- render root ----------------
function render() {
  if (!S.data) return;
  $$('.topnav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === S.view));
  renderSidebar();
  const main = $('#main');
  const scroll = main.scrollTop;
  if (!project() && !['projects', 'mcp'].includes(S.view)) S.view = 'projects';
  ({ projects: viewProjects, summary: viewSummary, integrations: viewIntegrations, documents: viewDocuments, board: viewBoard, backlog: viewBacklog, issues: viewIssues, epics: viewEpics, settings: viewSettings, mcp: viewMcp }[S.view] || viewBoard)(main);
  main.scrollTop = scroll;
  // Refresh an open issue detail unless the user is typing in it.
  if (S.modalKind === 'issue' && S.openIssueId) {
    const a = document.activeElement;
    const typing = a && $('#modal').contains(a) && /INPUT|TEXTAREA/.test(a.tagName);
    if (!issueById(S.openIssueId)) closeModal();
    else if (!typing && !$('#modal .desc-edit')) renderIssueDetail();
  }
}
function go(view) { S.view = view; store.set('view', view); render(); $('#main').scrollTop = 0; }
function selectProject(id) { S.projectId = id; store.set('projectId', id); S.board.assignees.clear(); if (['projects', 'mcp'].includes(S.view)) S.view = 'board'; store.set('view', S.view); render(); }

function renderSidebar() {
  const p = project();
  const sb = $('#sidebar');
  const item = (v, label, icon, count) => `<button class="side-item ${S.view === v ? 'active' : ''}" data-view="${v}">${icon}<span class="side-label">${label}</span>${count != null ? `<span class="side-count">${count}</span>` : ''}</button>`;
  const pis = p ? S.data.issues.filter(i => i.projectId === p.id) : [];
  const sp = p && S.data.sprints.find(s => s.projectId === p.id && s.state === 'active');
  const counts = {
    backlog: pis.filter(i => !i.sprintId && i.type !== 'epic').length,
    board: pis.filter(i => i.type !== 'epic' && i.status !== 'done' && (!sp || i.sprintId === sp.id)).length,
    issues: pis.length,
    epics: pis.filter(i => i.type === 'epic').length,
    documents: (S.data.documents || []).filter(d => d.projectId === p.id).length,
  };
  const I = {
    summary: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/></svg>',
    backlog: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z"/></svg>',
    board: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M4 4h4v16H4zm6 0h4v10h-4zm6 0h4v13h-4z"/></svg>',
    issues: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h2v2H3zm4 0h14v2H7zM3 11h2v2H3zm4 0h14v2H7zm-4 6h2v2H3zm4 0h14v2H7z"/></svg>',
    epics: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
    documents: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V9h5.5L13 3.5ZM8 13v2h8v-2H8Zm0 4v2h5v-2H8Z"/></svg>',
    integrations: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M17 7h-4v2h4a3 3 0 0 1 0 6h-4v2h4a5 5 0 0 0 0-10Zm-6 8H7a3 3 0 0 1 0-6h4V7H7a5 5 0 0 0 0 10h4v-2Zm-3-4h8v2H8v-2Z"/></svg>',
    settings: '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1L11 21h4l.4-2.7a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5ZM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>',
  };
  sb.innerHTML = p ? `
    <div class="project-switch" id="projSwitch">
      <div class="project-avatar" style="background:${projColor(p.key)}">${esc(p.key.slice(0, 2))}</div>
      <div style="min-width:0;flex:1"><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.key)} · Software project</div></div>
      <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>
    </div>
    <div class="side-section">Overview</div>
    ${item('summary', 'Summary', I.summary)}
    <div class="side-section">Planning</div>
    ${item('backlog', 'Backlog', I.backlog, counts.backlog)}
    ${item('board', 'Board', I.board, counts.board)}
    ${item('issues', 'Issues', I.issues, counts.issues)}
    ${item('epics', 'Epics', I.epics, counts.epics)}
    <div class="side-section">Project</div>
    ${item('documents', 'Documents', I.documents, counts.documents)}
    ${item('integrations', 'Integrations', I.integrations)}
    ${item('settings', 'Project settings', I.settings)}
    <div class="side-footer">
      <div class="mcp-card" id="sbMcp">
        <div class="mcp-card-head"><span class="pulse"></span>Claude MCP</div>
        <div>Let Claude manage this project. Its changes show up here live.</div>
        <span class="mcp-link">Set up connection →</span>
      </div>
      <div class="kbd-hint"><kbd>C</kbd> create <kbd>/</kbd> search <kbd>Esc</kbd> close</div>
    </div>
  ` : `<div class="side-section">No project</div><button class="btn btn-primary" style="margin:8px" id="sbNewProj">Create project</button>`;

  $$('.side-item', sb).forEach(b => b.onclick = () => go(b.dataset.view));
  $('#sbMcp', sb)?.addEventListener('click', () => go('mcp'));
  $('#sbNewProj', sb)?.addEventListener('click', openCreateProject);
  $('#projSwitch', sb)?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeDropdowns();
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    dd.style.cssText = 'top:52px;left:0;right:0';
    dd.innerHTML = S.data.projects.map(x => `<div class="dropdown-item" data-id="${x.id}"><div class="project-avatar" style="width:24px;height:24px;font-size:10px;background:${projColor(x.key)}">${esc(x.key.slice(0, 2))}</div>${esc(x.name)} <span class="muted">(${esc(x.key)})</span></div>`).join('')
      + `<div class="dropdown-sep"></div><div class="dropdown-item" data-act="all">View all projects</div><div class="dropdown-item" data-act="new">Create project</div>`;
    $('#projSwitch').appendChild(dd);
    dd.onclick = (ev) => {
      ev.stopPropagation();
      const it = ev.target.closest('.dropdown-item'); if (!it) return;
      closeDropdowns();
      if (it.dataset.id) selectProject(it.dataset.id);
      else if (it.dataset.act === 'all') go('projects');
      else openCreateProject();
    };
  });
}
function closeDropdowns() { $$('.dropdown').forEach(d => d.remove()); }
document.addEventListener('click', closeDropdowns);

function pageHeader(title, actions = '') {
  const p = project();
  return `<div class="breadcrumbs"><span class="link" data-go="projects">Projects</span>${p ? ` / <span class="link" data-go="board">${esc(p.name)}</span>` : ''}</div>
    <div class="page-head"><h1>${title}</h1><div class="spacer"></div>${actions}</div>`;
}
function bindHeader(root) { $$('[data-go]', root).forEach(el => el.onclick = () => go(el.dataset.go)); }

// ---------------- Projects ----------------
function viewProjects(root) {
  const ps = S.data.projects;
  root.innerHTML = `
    <div class="page-head"><h1>Projects</h1><div class="spacer"></div><button class="btn btn-primary" id="newProj">Create project</button></div>
    ${ps.length ? `<div class="project-cards">${ps.map(p => {
      const is = S.data.issues.filter(i => i.projectId === p.id && i.type !== 'epic');
      const n = is.length || 1;
      const cnt = (s) => is.filter(i => i.status === s).length;
      const sp = S.data.sprints.find(s => s.projectId === p.id && s.state === 'active');
      return `<div class="project-card" data-id="${p.id}">
        <div class="top"><div class="project-avatar" style="background:${projColor(p.key)}">${esc(p.key.slice(0, 2))}</div><div><b>${esc(p.name)}</b><span class="muted">${esc(p.key)} · Lead: ${esc(p.lead)}</span></div></div>
        <div class="muted" style="min-height:20px">${esc(p.description || '')}</div>
        <div class="progress"><span style="width:${cnt('done') / n * 100}%;background:#2A835F"></span><span style="width:${cnt('in_review') / n * 100}%;background:#C5DDC9"></span><span style="width:${cnt('in_progress') / n * 100}%;background:#8BBB92"></span></div>
        <div class="muted" style="font-size:12px">${is.length} issues · ${cnt('done')} done${sp ? ` · ${esc(sp.name)} active` : ''}</div>
      </div>`;
    }).join('')}</div>` : `<div class="empty-state"><h2>No projects yet</h2><p>Create your first project to start tracking work.</p></div>`}`;
  $('#newProj').onclick = openCreateProject;
  $$('.project-card', root).forEach(c => c.onclick = () => selectProject(c.dataset.id));
}

function openCreateProject() {
  openModal(`
    <div class="modal-head"><h2>Create project</h2></div>
    <div class="modal-body">
      <div class="field"><label>Name <span class="req">*</span></label><input class="input" id="pName" placeholder="e.g. Website Redesign" /></div>
      <div class="field"><label>Key <span class="req">*</span></label><input class="input" id="pKey" placeholder="e.g. WEB" maxlength="10" style="text-transform:uppercase" /></div>
      <div class="field"><label>Description</label><textarea class="textarea" id="pDesc" style="min-height:70px"></textarea></div>
    </div>
    <div class="modal-foot"><button class="btn btn-subtle" data-close>Cancel</button><button class="btn btn-primary" id="pCreate">Create</button></div>`, 'form');
  let keyTouched = false;
  $('#pKey').oninput = () => { keyTouched = true; };
  $('#pName').oninput = (e) => {
    if (keyTouched) return;
    const words = e.target.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    $('#pKey').value = (words.length > 1 ? words.map(w => w[0]).join('') : (words[0] || '').slice(0, 4)).slice(0, 10);
  };
  $('#pName').focus();
  $('#pCreate').onclick = async () => {
    const p = await call('createProject', { name: $('#pName').value.trim(), key: $('#pKey').value.trim(), description: $('#pDesc').value });
    closeModal();
    await load();
    selectProject(p.id);
    toast(`Project ${p.key} created`);
  };
}

// ---------------- Board ----------------
function boardFilter(list) {
  const f = S.board;
  return list.filter(i =>
    (!f.q || `${i.key} ${i.title}`.toLowerCase().includes(f.q.toLowerCase())) &&
    (!f.type || i.type === f.type) &&
    (!f.assignees.size || f.assignees.has(i.assignee || '__none')));
}
function assigneeFilterHtml(issues) {
  const names = [...new Set(issues.map(i => i.assignee).filter(Boolean))].sort();
  return `<div class="avatar-filter">${names.map(n => `<span data-a="${esc(n)}" class="${S.board.assignees.has(n) ? 'on' : ''}">${avatar(n, 'lg')}</span>`).join('')}
    <span data-a="__none" class="${S.board.assignees.has('__none') ? 'on' : ''}">${avatar(null, 'lg')}</span></div>`;
}
function card(i) {
  const epic = i.epicId && issueById(i.epicId);
  const tags = [...(epic ? [`<span class="epic-chip">${esc(epic.title)}</span>`] : []), ...i.labels.map(l => `<span class="label-chip">${esc(l)}</span>`), ...(dueChip(i) ? [dueChip(i)] : [])];
  return `<div class="card ${i.status === 'done' ? 'done' : ''}" draggable="true" data-id="${i.id}">
    <div class="card-title">${esc(i.title)}</div>
    ${tags.length ? `<div class="card-tags">${tags.join('')}</div>` : ''}
    <div class="card-foot">${typeIcon(i.type)}<span class="key">${esc(i.key)}</span>${linkBadges(i)}<span class="spacer"></span>
      ${i.storyPoints != null ? `<span class="points">${i.storyPoints}</span>` : ''}${priorityIcon(i.priority)}${avatar(i.assignee)}</div>
  </div>`;
}
function viewBoard(root) {
  const sprint = activeSprint();
  const all = projectIssues().filter(i => i.type !== 'epic' && (!sprint || i.sprintId === sprint.id));
  const issues = boardFilter(all);
  const actions = sprint ? `<button class="btn" id="completeSprint">Complete sprint</button>` : `<button class="btn" data-go="backlog">Plan a sprint</button>`;
  const doneN = all.filter(i => i.status === 'done').length;
  const pct = all.length ? Math.round(doneN / all.length * 100) : 0;
  const days = sprint ? Math.max(1, Math.ceil((Date.now() - new Date(sprint.startDate)) / 86400000)) : 0;
  root.innerHTML = `${pageHeader(sprint ? esc(sprint.name) : 'Board', actions)}
    ${sprint ? `<div class="sprint-strip">
      ${sprint.goal ? `<div class="sprint-goal"><svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 16a6 6 0 1 1 0-12 6 6 0 0 1 0 12Zm0-9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>${esc(sprint.goal)}</div>` : ''}
      <div class="sprint-progress"><div class="bar"><span style="width:${pct}%"></span></div><span><b>${pct}%</b> done · ${doneN}/${all.length} issues · day ${days}</span></div>
    </div>` : `<div class="page-sub">No active sprint — showing all issues in the project.</div>`}
    <div class="toolbar">
      <input class="input" id="bq" placeholder="Search board" value="${esc(S.board.q)}" />
      ${assigneeFilterHtml(all)}
      <select class="select" id="btype">${opt('', 'All types', !S.board.type)}${TYPES.filter(t => t !== 'epic').map(t => opt(t, cap(t), S.board.type === t)).join('')}</select>
      ${(S.board.q || S.board.type || S.board.assignees.size) ? `<button class="btn btn-subtle" id="bclear">Clear filters</button>` : ''}
    </div>
    <div class="board">${STATUSES.map(s => {
      const col = issues.filter(i => i.status === s).sort(byOrder);
      return `<div class="column" data-status="${s}">
        <div class="column-head"><span class="status-dot sd-${s}"></span>${STATUS_LABELS[s]} <span class="count">${col.length}</span>${s === 'done' ? ' <svg width="14" height="14" viewBox="0 0 24 24" style="color:#2A835F"><path fill="currentColor" d="m9 16.2-4.2-4.2-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>' : ''}</div>
        <div class="column-body">${col.length ? col.map(card).join('') : '<div class="col-empty">Drop issues here</div>'}</div>
        <button class="btn column-create" data-status="${s}">+ Create issue</button>
      </div>`;
    }).join('')}</div>`;
  bindHeader(root);
  const bq = $('#bq');
  bq.oninput = () => { S.board.q = bq.value; const pos = bq.selectionStart; render(); const n = $('#bq'); n.focus(); n.setSelectionRange(pos, pos); };
  $('#btype').onchange = (e) => { S.board.type = e.target.value; render(); };
  $('#bclear')?.addEventListener('click', () => { S.board = { q: '', assignees: new Set(), type: '' }; render(); });
  $$('.avatar-filter [data-a]', root).forEach(el => el.onclick = () => { const a = el.dataset.a; S.board.assignees.has(a) ? S.board.assignees.delete(a) : S.board.assignees.add(a); render(); });
  $('#completeSprint')?.addEventListener('click', () => completeSprintFlow(sprint));
  $$('.column-create', root).forEach(b => b.onclick = () => openCreateIssue({ status: b.dataset.status, sprintId: sprint?.id }));
  $$('.card', root).forEach(c => c.onclick = () => openIssue(c.dataset.id));
  setupDnD(root, '.card', '.column', '.column-body', (col) => ({ status: col.dataset.status }));
}

// Generic drag & drop with reordering. `targetPatch(container)` returns the fields to set on drop.
function setupDnD(root, itemSel, containerSel, listSel, targetPatch) {
  let dragId = null;
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';
  $$(itemSel, root).forEach(el => {
    el.addEventListener('dragstart', (e) => { dragId = el.dataset.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); indicator.remove(); $$('.bl-empty, .col-empty', root).forEach(x => x.classList.remove('hidden')); $$(containerSel, root).forEach(c => c.classList.remove('drop')); dragId = null; });
  });
  const afterElement = (list, y) => {
    const els = $$(`${itemSel}:not(.dragging)`, list);
    return els.find(el => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
  };
  $$(containerSel, root).forEach(container => {
    const list = $(listSel, container) || container;
    container.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      $$(containerSel, root).forEach(c => c.classList.toggle('drop', c === container));
      const after = afterElement(list, e.clientY);
      $('.bl-empty, .col-empty', list)?.classList.add('hidden');
      after ? list.insertBefore(indicator, after) : list.appendChild(indicator);
    });
    container.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragId) return;
      const id = dragId;
      const items = $$(`${itemSel}:not(.dragging)`, list);
      const idx = [...list.children].filter(c => c === indicator || (c.matches(itemSel) && !c.classList.contains('dragging'))).indexOf(indicator);
      const before = items[idx - 1] && issueById(items[idx - 1].dataset.id);
      const after = items[idx] && issueById(items[idx].dataset.id);
      let order;
      if (before && after) order = ((before.order || 0) + (after.order || 0)) / 2;
      else if (before) order = (before.order || 0) + 1;
      else if (after) order = (after.order || 0) - 1;
      indicator.remove();
      const patch = { ...targetPatch(container) };
      if (order !== undefined) patch.order = order;
      await mutate('updateIssue', id, patch);
    });
  });
}

async function completeSprintFlow(sprint) {
  const open = S.data.issues.filter(i => i.sprintId === sprint.id && i.status !== 'done').length;
  const done = S.data.issues.filter(i => i.sprintId === sprint.id && i.status === 'done').length;
  if (await confirmModal(`Complete ${esc(sprint.name)}?`, `${done} issue(s) done. ${open} incomplete issue(s) will move back to the backlog.`, 'Complete sprint')) {
    await mutate('completeSprint', sprint.id);
    toast(`${sprint.name} completed`);
  }
}

// ---------------- Backlog ----------------
function blRow(i) {
  const epic = i.epicId && issueById(i.epicId);
  return `<div class="bl-row ${i.status === 'done' ? 'done' : ''}" draggable="true" data-id="${i.id}">
    ${typeIcon(i.type)}<span class="key">${esc(i.key)}</span><span class="t">${esc(i.title)}</span>${linkBadges(i)}
    ${epic ? `<span class="epic-chip">${esc(epic.title)}</span>` : ''}
    ${dueChip(i)}${lozenge(i.status)}
    <span class="points" style="${i.storyPoints == null ? 'visibility:hidden' : ''}">${i.storyPoints ?? '-'}</span>
    ${priorityIcon(i.priority)}${avatar(i.assignee)}
  </div>`;
}
function viewBacklog(root) {
  const issues = projectIssues().filter(i => i.type !== 'epic');
  const q = (S.board.q || '').toLowerCase();
  const match = (i) => !q || `${i.key} ${i.title}`.toLowerCase().includes(q);
  const sprints = projectSprints().filter(s => s.state !== 'completed').sort((a, b) => (a.state === 'active' ? -1 : b.state === 'active' ? 1 : a.createdAt.localeCompare(b.createdAt)));
  const hasActive = sprints.some(s => s.state === 'active');
  const section = (id, title, meta, list, actions, goal = '') => {
    const pts = (st) => list.filter(i => !st || i.status === st).reduce((n, i) => n + (i.storyPoints || 0), 0);
    const collapsed = S.collapsed.has(id);
    return `<div class="bl-section" data-sprint="${id}">
      <div class="bl-head ${collapsed ? 'collapsed' : ''}">
        <span class="chev" data-toggle="${id}"><svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg></span>
        <span class="bl-title">${title}</span><span class="bl-meta">${meta} (${list.length} issue${list.length === 1 ? '' : 's'})</span>
        <span class="spacer"></span>
        <span class="bl-stats" title="Story points: To Do / In Progress / Done"><span class="lozenge lz-todo">${pts('todo') + pts('in_review')}</span><span class="lozenge lz-in_progress">${pts('in_progress')}</span><span class="lozenge lz-done">${pts('done')}</span></span>
        ${actions}
      </div>
      ${goal && !collapsed ? `<div class="bl-goal">${esc(goal)}</div>` : ''}
      ${collapsed ? '' : `<div class="bl-list">${list.length ? list.map(blRow).join('') : `<div class="bl-empty">${id === 'backlog' ? 'Your backlog is empty.' : 'Plan a sprint by dragging issues here.'}</div>`}</div>
      <div class="inline-create-wrap" data-sprint="${id}"><button class="btn add-row">+ Create issue</button></div>`}
    </div>`;
  };
  root.innerHTML = `${pageHeader('Backlog')}
    <div class="toolbar"><input class="input" id="blq" placeholder="Search backlog" value="${esc(S.board.q)}" /></div>
    ${sprints.map(s => {
      const list = issues.filter(i => i.sprintId === s.id && match(i)).sort(byOrder);
      const meta = s.state === 'active' ? `Active since ${fmtDate(s.startDate)}` : 'Planned';
      const actions = s.state === 'active'
        ? `<button class="btn btn-sm" data-complete="${s.id}">Complete sprint</button>`
        : `<button class="btn btn-sm ${hasActive ? '' : 'btn-primary'}" data-start="${s.id}" ${hasActive ? 'disabled title="Complete the active sprint first"' : ''}>Start sprint</button>`;
      return section(s.id, esc(s.name), meta, list, `${actions}<button class="icon-btn" data-sprint-menu="${s.id}" title="Sprint actions">⋯</button>`, s.goal);
    }).join('')}
    ${section('backlog', 'Backlog', '', issues.filter(i => !i.sprintId && match(i)).sort(byOrder), `<button class="btn btn-sm" id="newSprint">Create sprint</button>`)}`;
  bindHeader(root);
  const blq = $('#blq');
  blq.oninput = () => { S.board.q = blq.value; const pos = blq.selectionStart; render(); const n = $('#blq'); n.focus(); n.setSelectionRange(pos, pos); };
  $$('[data-toggle]', root).forEach(el => el.onclick = () => { const id = el.dataset.toggle; S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id); store.set('collapsed', [...S.collapsed]); render(); });
  $('#newSprint').onclick = async () => { await mutate('createSprint', { project: S.projectId }); toast('Sprint created'); };
  $$('[data-start]', root).forEach(b => b.onclick = () => openStartSprint(S.data.sprints.find(s => s.id === b.dataset.start)));
  $$('[data-complete]', root).forEach(b => b.onclick = () => completeSprintFlow(S.data.sprints.find(s => s.id === b.dataset.complete)));
  $$('[data-sprint-menu]', root).forEach(b => b.onclick = (e) => {
    e.stopPropagation(); closeDropdowns();
    const s = S.data.sprints.find(x => x.id === b.dataset.sprintMenu);
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    dd.innerHTML = `<div class="dropdown-item" data-a="edit">Edit sprint</div><div class="dropdown-item" data-a="del" style="color:var(--danger)">Delete sprint</div>`;
    const r = b.getBoundingClientRect();
    dd.style.cssText = `position:fixed;top:${r.bottom + 4}px;left:${r.right - 220}px`;
    document.body.appendChild(dd);
    dd.onclick = async (ev) => {
      ev.stopPropagation();
      const a = ev.target.closest('[data-a]')?.dataset.a; closeDropdowns();
      if (a === 'edit') openStartSprint(s, true);
      if (a === 'del' && await confirmModal(`Delete ${esc(s.name)}?`, 'Its issues will move to the backlog.', 'Delete', true)) await mutate('deleteSprint', s.id);
    };
  });
  $$('.bl-row', root).forEach(r => r.onclick = () => openIssue(r.dataset.id));
  $$('.inline-create-wrap', root).forEach(w => $('.add-row', w).onclick = () => inlineCreate(w));
  setupDnD(root, '.bl-row', '.bl-section', '.bl-list', (sec) => ({ sprintId: sec.dataset.sprint === 'backlog' ? null : sec.dataset.sprint }));
}
function inlineCreate(wrap) {
  wrap.innerHTML = `<div class="inline-create"><select class="select" id="icType">${TYPES.filter(t => t !== 'epic').map(t => opt(t, cap(t), t === 'task')).join('')}</select><input class="input" id="icTitle" placeholder="What needs to be done?" /><button class="btn btn-primary" id="icSave">Create</button></div>`;
  const input = $('#icTitle', wrap);
  input.focus();
  const save = async () => {
    if (!input.value.trim()) return render();
    const sid = wrap.dataset.sprint === 'backlog' ? null : wrap.dataset.sprint;
    await call('createIssue', { project: S.projectId, title: input.value, type: $('#icType', wrap).value, sprintId: sid });
    await load();
    const w = $(`.inline-create-wrap[data-sprint="${wrap.dataset.sprint}"]`);
    if (w) inlineCreate(w);
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { e.stopPropagation(); render(); } };
  $('#icSave', wrap).onclick = save;
}
function openStartSprint(s, editOnly = false) {
  openModal(`
    <div class="modal-head"><h2>${editOnly ? 'Edit sprint' : 'Start sprint'}</h2></div>
    <div class="modal-body">
      <p class="muted">${S.data.issues.filter(i => i.sprintId === s.id).length} issue(s) will be included in this sprint.</p>
      <div class="field"><label>Sprint name <span class="req">*</span></label><input class="input" id="sName" value="${esc(s.name)}" /></div>
      <div class="field"><label>Sprint goal</label><textarea class="textarea" id="sGoal" style="min-height:70px">${esc(s.goal || '')}</textarea></div>
    </div>
    <div class="modal-foot"><button class="btn btn-subtle" data-close>Cancel</button><button class="btn btn-primary" id="sGo">${editOnly ? 'Save' : 'Start'}</button></div>`, 'form');
  $('#sGo').onclick = async () => {
    await call('updateSprint', s.id, { name: $('#sName').value.trim() || s.name, goal: $('#sGoal').value });
    if (!editOnly) await call('startSprint', s.id);
    closeModal(); await load();
    if (!editOnly) { toast(`${s.name} started`); go('board'); }
  };
}

// ---------------- Issues list ----------------
function viewIssues(root) {
  const f = S.list;
  const users = S.data.users;
  let list = projectIssues().filter(i =>
    (!f.q || `${i.key} ${i.title} ${i.description}`.toLowerCase().includes(f.q.toLowerCase())) &&
    (!f.status || i.status === f.status) && (!f.type || i.type === f.type) && (!f.priority || i.priority === f.priority) &&
    (!f.assignee || (f.assignee === '__none' ? !i.assignee : i.assignee === f.assignee)));
  const keyNum = (k) => parseInt(k.split('-')[1], 10);
  const sorters = {
    key: (a, b) => keyNum(a.key) - keyNum(b.key), title: (a, b) => a.title.localeCompare(b.title),
    type: (a, b) => a.type.localeCompare(b.type), status: (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status),
    priority: (a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority),
    assignee: (a, b) => (a.assignee || '~').localeCompare(b.assignee || '~'), updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    points: (a, b) => (a.storyPoints ?? -1) - (b.storyPoints ?? -1),
  };
  list.sort((a, b) => sorters[f.sort](a, b) * f.dir);
  const th = (k, label) => `<th data-sort="${k}">${label}${f.sort === k ? (f.dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  root.innerHTML = `${pageHeader('Issues', `<button class="btn btn-primary" id="liNew">Create issue</button>`)}
    <div class="toolbar">
      <input class="input" id="lq" placeholder="Search issues" value="${esc(f.q)}" />
      <select class="select" data-f="status">${opt('', 'Status: All')}${STATUSES.map(s => opt(s, STATUS_LABELS[s], f.status === s)).join('')}</select>
      <select class="select" data-f="type">${opt('', 'Type: All')}${TYPES.map(s => opt(s, cap(s), f.type === s)).join('')}</select>
      <select class="select" data-f="priority">${opt('', 'Priority: All')}${PRIORITIES.map(s => opt(s, cap(s), f.priority === s)).join('')}</select>
      <select class="select" data-f="assignee">${opt('', 'Assignee: All')}${opt('__none', 'Unassigned', f.assignee === '__none')}${users.map(s => opt(s, s, f.assignee === s)).join('')}</select>
      <span class="muted">${list.length} issue${list.length === 1 ? '' : 's'}</span>
    </div>
    <table class="table"><thead><tr>${th('type', 'Type')}${th('key', 'Key')}${th('title', 'Summary')}${th('status', 'Status')}${th('priority', 'Priority')}${th('assignee', 'Assignee')}${th('points', 'Points')}${th('updated', 'Updated')}</tr></thead>
    <tbody>${list.map(i => `<tr class="clickable" data-id="${i.id}">
      <td>${typeIcon(i.type)}</td><td class="muted" style="white-space:nowrap">${esc(i.key)}</td><td>${esc(i.title)}</td><td>${lozenge(i.status)}</td>
      <td><div class="cell-flex">${priorityIcon(i.priority)}${cap(i.priority)}</div></td>
      <td><div class="cell-flex">${avatar(i.assignee)}${esc(i.assignee || 'Unassigned')}</div></td>
      <td>${i.storyPoints ?? ''}</td><td class="muted" style="white-space:nowrap">${timeAgo(i.updatedAt)}</td></tr>`).join('')}</tbody></table>
    ${list.length ? '' : '<div class="empty-state">No issues match your filters.</div>'}`;
  bindHeader(root);
  $('#liNew').onclick = () => openCreateIssue();
  const lq = $('#lq');
  lq.oninput = () => { f.q = lq.value; const pos = lq.selectionStart; render(); const n = $('#lq'); n.focus(); n.setSelectionRange(pos, pos); };
  $$('[data-f]', root).forEach(s => s.onchange = () => { f[s.dataset.f] = s.value; render(); });
  $$('th[data-sort]', root).forEach(t => t.onclick = () => { if (f.sort === t.dataset.sort) f.dir *= -1; else { f.sort = t.dataset.sort; f.dir = 1; } render(); });
  $$('tr[data-id]', root).forEach(r => r.onclick = () => openIssue(r.dataset.id));
}

// ---------------- Epics ----------------
function viewEpics(root) {
  const list = epics().sort(byOrder);
  root.innerHTML = `${pageHeader('Epics', `<button class="btn btn-primary" id="epNew">Create epic</button>`)}
    ${list.length ? `<div class="project-cards">${list.map(e => {
      const ch = S.data.issues.filter(i => i.epicId === e.id);
      const n = ch.length || 1, done = ch.filter(i => i.status === 'done').length, prog = ch.filter(i => i.status === 'in_progress' || i.status === 'in_review').length;
      return `<div class="project-card" data-id="${e.id}">
        <div class="top">${typeIcon('epic')}<div style="flex:1"><b>${esc(e.title)}</b><span class="muted">${esc(e.key)}</span></div>${lozenge(e.status)}</div>
        <div class="progress"><span style="width:${done / n * 100}%;background:#2A835F"></span><span style="width:${prog / n * 100}%;background:#8BBB92"></span></div>
        <div class="muted" style="font-size:12px">${ch.length} child issue${ch.length === 1 ? '' : 's'} · ${ch.length ? Math.round(done / n * 100) : 0}% done</div>
      </div>`;
    }).join('')}</div>` : `<div class="empty-state"><h2>No epics yet</h2><p>Epics group related stories, tasks and bugs into a larger body of work.</p></div>`}`;
  bindHeader(root);
  $('#epNew').onclick = () => openCreateIssue({ type: 'epic' });
  $$('.project-card', root).forEach(c => c.onclick = () => openIssue(c.dataset.id));
}

// ---------------- Summary dashboard ----------------
const STATUS_COLORS = { todo: '#C3CFCA', in_progress: '#8BBB92', in_review: '#E2B203', done: '#2A835F' };
function donut(segments, size = 148, stroke = 20) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = total ? segments.filter(s => s.value).map(s => {
    const len = s.value / total * c;
    const el = `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="${s.color}" stroke-width="${stroke}" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}"><title>${esc(s.label)}: ${s.value}</title></circle>`;
    offset += len;
    return el;
  }).join('') : `<circle r="${r}" cx="${size / 2}" cy="${size / 2}" fill="none" stroke="var(--bg-neutral)" stroke-width="${stroke}"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg)">${arcs}</svg>`;
}
function hbars(rows, color = 'var(--green)') {
  const max = Math.max(1, ...rows.map(r => r.value));
  return `<div class="hbars">${rows.map(r => `<div class="hbar-row"><div class="hbar-label">${r.label}</div><div class="hbar-track"><span style="width:${r.value / max * 100}%;background:${r.color || color}"></span></div><div class="hbar-val">${r.value}</div></div>`).join('')}</div>`;
}
function viewSummary(root) {
  const p = project();
  const is = projectIssues();
  const work = is.filter(i => i.type !== 'epic');
  const week = Date.now() - 7 * 86400000;
  const recent = (d) => new Date(d).getTime() > week;
  const soon = work.filter(i => i.dueDate && i.status !== 'done' && new Date(i.dueDate + 'T23:59:59') - Date.now() < 7 * 86400000);
  const overdue = soon.filter(i => new Date(i.dueDate + 'T23:59:59') < Date.now());
  const tiles = [
    ['Completed', work.filter(i => i.status === 'done' && recent(i.updatedAt)).length, 'in the last 7 days', 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z'],
    ['Updated', is.filter(i => recent(i.updatedAt)).length, 'in the last 7 days', 'M21 12a9 9 0 1 1-2.6-6.4L16 8h6V2l-2.2 2.2A11 11 0 1 0 23 12h-2Z'],
    ['Created', is.filter(i => recent(i.createdAt)).length, 'in the last 7 days', 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z'],
    ['Due soon', soon.length, overdue.length ? `${overdue.length} overdue` : 'in the next 7 days', 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 11h-5v-2h3V6h2v7Z'],
  ];
  const sp = activeSprint();
  const spIssues = sp ? work.filter(i => i.sprintId === sp.id) : [];
  const spDone = spIssues.filter(i => i.status === 'done');
  const pts = (l) => l.reduce((n, i) => n + (i.storyPoints || 0), 0);
  const people = [...new Set(work.map(i => i.assignee || null))];
  const open = work.filter(i => i.status !== 'done');
  const workload = people.map(a => ({ name: a, value: open.filter(i => (i.assignee || null) === a).length })).filter(x => x.value).sort((a, b) => b.value - a.value);
  const comments = S.data.comments.filter(c => is.some(i => i.id === c.issueId)).map(c => ({ kind: 'comment', at: c.createdAt, who: c.author, issue: issueById(c.issueId), body: c.body }));
  const updates = is.map(i => ({ kind: i.createdAt === i.updatedAt ? 'created' : 'updated', at: i.updatedAt, who: i.createdAt === i.updatedAt ? i.reporter : null, issue: i }));
  const feed = [...comments, ...updates].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  const hour = new Date().getHours();
  root.innerHTML = `${pageHeader('Summary', `<button class="btn btn-primary" id="smNew">Create issue</button>`)}
    <div class="page-sub">${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'} — here's where <b>${esc(p.name)}</b> stands.</div>
    <div class="tiles">${tiles.map(([t, v, s, d], n) => `<div class="tile ${n === 3 && overdue.length ? 'warn' : ''}"><div class="tile-icon"><svg width="20" height="20" viewBox="0 0 24 24"><path fill="currentColor" d="${d}"/></svg></div><div><div class="tile-val">${v} <span>${t.toLowerCase()}</span></div><div class="tile-sub">${s}</div></div></div>`).join('')}</div>
    <div class="dash">
      <section class="panel">
        <div class="panel-head"><h3>Status overview</h3><span class="muted">${work.length} issues</span></div>
        <div class="donut-wrap">
          <div class="donut">${donut(STATUSES.map(s => ({ label: STATUS_LABELS[s], value: work.filter(i => i.status === s).length, color: STATUS_COLORS[s] })))}
            <div class="donut-center"><b>${work.length ? Math.round(work.filter(i => i.status === 'done').length / work.length * 100) : 0}%</b><span>done</span></div></div>
          <div class="legend">${STATUSES.map(s => `<div class="legend-row" data-status="${s}"><span class="legend-dot" style="background:${STATUS_COLORS[s]}"></span>${STATUS_LABELS[s]}<span class="spacer"></span><b>${work.filter(i => i.status === s).length}</b></div>`).join('')}</div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>${sp ? esc(sp.name) : 'Sprint'}</h3>${sp ? `<span class="lozenge lz-in_progress">Active</span>` : ''}</div>
        ${sp ? `<p class="muted" style="margin:0 0 14px">${esc(sp.goal || 'No sprint goal set.')}</p>
          <div class="big-progress"><span style="width:${spIssues.length ? spDone.length / spIssues.length * 100 : 0}%"></span></div>
          <div class="sprint-stats">
            <div><b>${spDone.length}/${spIssues.length}</b><span>issues done</span></div>
            <div><b>${pts(spDone)}/${pts(spIssues)}</b><span>story points</span></div>
            <div><b>${Math.max(1, Math.ceil((Date.now() - new Date(sp.startDate)) / 86400000))}</b><span>days in</span></div>
          </div>
          <button class="btn" data-go="board" style="margin-top:14px">Open board →</button>`
        : `<div class="panel-empty">No active sprint.<br><button class="btn btn-sm" data-go="backlog" style="margin-top:10px">Plan one in the backlog</button></div>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Priority breakdown</h3><span class="muted">open issues</span></div>
        ${hbars(PRIORITIES.map(pr => ({ label: `<span class="cell-flex">${priorityIcon(pr)}${cap(pr)}</span>`, value: open.filter(i => i.priority === pr).length, color: { highest: '#C9372C', high: '#E2483D', medium: '#E2B203', low: '#8BBB92', lowest: '#2A835F' }[pr] })))}
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Team workload</h3><span class="muted">open issues</span></div>
        ${workload.length ? hbars(workload.map(w => ({ label: `<span class="cell-flex">${avatar(w.name)}${esc(w.name || 'Unassigned')}</span>`, value: w.value, color: w.name ? 'var(--green)' : '#C3CFCA' }))) : '<div class="panel-empty">Nothing open — nice work.</div>'}
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Types of work</h3></div>
        ${hbars(TYPES.map(t => ({ label: `<span class="cell-flex">${typeIcon(t)}${cap(t)}</span>`, value: is.filter(i => i.type === t).length, color: { task: '#4BADE8', bug: '#E5493A', story: '#63BA3C', epic: '#904EE2' }[t] })))}
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Recent activity</h3></div>
        <div class="feed">${feed.map(f => `<div class="feed-row" data-open="${f.issue.id}">
          ${f.kind === 'comment' ? avatar(f.who) : `<span class="feed-icon">${typeIcon(f.issue.type)}</span>`}
          <div class="feed-text">${f.kind === 'comment' ? `<b>${esc(f.who)}</b> commented on` : f.kind === 'created' ? `<b>${esc(f.who || 'Someone')}</b> created` : 'Updated'} <span class="feed-key">${esc(f.issue.key)}</span> ${esc(f.issue.title)}
            ${f.kind === 'comment' ? `<div class="feed-quote">${esc(f.body.slice(0, 120))}</div>` : ''}</div>
          <span class="feed-when">${timeAgo(f.at)}</span></div>`).join('') || '<div class="panel-empty">No activity yet.</div>'}</div>
      </section>
    </div>`;
  bindHeader(root);
  $('#smNew').onclick = () => openCreateIssue();
  $$('[data-open]', root).forEach(el => el.onclick = () => openIssue(el.dataset.open));
  $$('.legend-row', root).forEach(el => el.onclick = () => { S.list.status = el.dataset.status; go('issues'); });
}

// ---------------- Settings ----------------
function viewSettings(root) {
  const p = project();
  root.innerHTML = `${pageHeader('Project settings')}
    <div style="max-width:560px">
      <div class="field"><label>Name</label><input class="input" id="psName" value="${esc(p.name)}" /></div>
      <div class="field"><label>Key</label><input class="input" value="${esc(p.key)}" disabled /></div>
      <div class="field"><label>Project lead</label><select class="select" id="psLead">${S.data.users.map(u => opt(u, u, u === p.lead)).join('')}</select></div>
      <div class="field"><label>Description</label><textarea class="textarea" id="psDesc">${esc(p.description || '')}</textarea></div>
      <button class="btn btn-primary" id="psSave">Save</button>
      <h3 style="margin-top:36px">People</h3>
      <p class="muted">People who can be assigned issues (shared across projects).</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">${S.data.users.map(u => { const n = S.data.issues.filter(i => i.assignee === u && i.status !== 'done').length; return `<span class="person-chip">${avatar(u)}<span>${esc(u)}</span>${n ? `<span class="muted" style="font-size:12px">${n} open</span>` : ''}${u === 'Me' ? '<span class="muted" style="font-size:12px">you</span>' : `<button class="person-remove" data-remove="${esc(u)}" title="Remove ${esc(u)}">×</button>`}</span>`; }).join('')}</div>
      <div class="row" style="max-width:360px"><input class="input" id="psUser" placeholder="Add a person" /><button class="btn" id="psAdd" style="flex:none">Add</button></div>
      <h3 style="margin-top:36px;color:var(--danger)">Danger zone</h3>
      <p class="muted">Deleting the project removes all its issues, sprints and comments.</p>
      <button class="btn btn-danger" id="psDel">Delete project</button>
    </div>`;
  bindHeader(root);
  $('#psSave').onclick = async () => { await mutate('updateProject', p.id, { name: $('#psName').value.trim() || p.name, lead: $('#psLead').value, description: $('#psDesc').value }); toast('Project saved'); };
  const add = async () => { const v = $('#psUser').value.trim(); if (v) { await mutate('addUser', v); toast(`${v} added`); } };
  $('#psAdd').onclick = add;
  $('#psUser').onkeydown = (e) => e.key === 'Enter' && add();
  $$('[data-remove]', root).forEach(b => b.onclick = async () => {
    const name = b.dataset.remove;
    const n = S.data.issues.filter(i => i.assignee === name).length;
    if (await confirmModal(`Remove ${esc(name)}?`, `${name} will be removed from the people list in all projects.${n ? ` Their ${n} assigned issue(s) will become unassigned.` : ''}`, 'Remove', true)) {
      await mutate('removeUser', name); toast(`${name} removed`);
    }
  });
  $('#psDel').onclick = async () => {
    if (await confirmModal(`Delete ${esc(p.name)}?`, 'This permanently deletes the project and all of its issues. This cannot be undone.', 'Delete project', true)) {
      await mutate('deleteProject', p.id); toast('Project deleted'); go('projects');
    }
  };
}

// ---------------- Connect Claude (MCP) ----------------
async function viewMcp(root) {
  const info = await window.taskflow.mcpInfo();
  if (S.view !== 'mcp') return;
  const cfg = JSON.stringify({ mcpServers: { taskflow: { command: 'node', args: [info.serverPath] } } }, null, 2);
  const cli = `claude mcp add taskflow --scope user -- node "${info.serverPath}"`;
  const tools = [
    ['list_projects', 'Projects with issue counts'], ['create_project', 'Create a new project'],
    ['list_issues', 'Search & filter issues'], ['get_issue', 'Full issue with comments'],
    ['create_issue', 'Create task/bug/story/epic'], ['update_issue', 'Edit any issue fields'],
    ['transition_issue', 'Move issue between columns'], ['assign_issue', 'Assign / unassign'],
    ['add_comment', 'Comment on an issue'], ['delete_issue', 'Delete an issue'],
    ['get_board', 'Board grouped by column'], ['list_sprints', 'Sprints with progress'],
    ['create_sprint', 'Create a sprint'], ['start_sprint', 'Start a sprint'],
    ['complete_sprint', 'Complete active sprint'], ['move_to_sprint', 'Move issues to sprint/backlog'],
    ['list_documents', 'PDFs in a project'], ['add_document', 'Upload a PDF'], ['list_users', 'People you can assign'], ['add_user', 'Add a person'], ['remove_user', 'Remove a person'],
  ];
  root.innerHTML = `<div class="mcp-page">
    <div class="page-head"><h1>Connect Claude</h1></div>
    <p class="page-sub" style="margin-top:-6px">TaskFlow ships with an MCP server. Once connected, Claude can read and manage your projects, issues and sprints, and every change shows up here live.</p>
    <div class="card-panel">
      <h3>Claude Code</h3>
      <p>Run this once in your terminal:</p>
      <pre class="code">${esc(cli)}</pre>
      <button class="btn" data-copy="cli">Copy command</button>
    </div>
    <div class="card-panel">
      <h3>Claude Desktop</h3>
      <p>Open <b>Settings → Developer → Edit Config</b> and add this to <code>claude_desktop_config.json</code>, then restart Claude Desktop:</p>
      <pre class="code">${esc(cfg)}</pre>
      <button class="btn" data-copy="cfg">Copy config</button>
    </div>
    <div class="card-panel">
      <h3>Available tools</h3>
      <div class="tools-list">${tools.map(([n, d]) => `<div><code>${n}</code><br>${d}</div>`).join('')}</div>
    </div>
    <div class="card-panel">
      <h3>Data</h3>
      <p>The app and the MCP server share a single file: <code>${esc(info.dataFile)}</code>. Requires Node.js 18+ on your PATH for the MCP server.</p>
      <button class="btn" id="openData">Open data folder</button>
    </div>
    <div class="card-panel">
      <h3>Try asking Claude</h3>
      <p>"What's on the DEMO board right now?"<br>"Create a high-priority bug in DEMO: login button unresponsive on Safari, assign it to Sam."<br>"Move everything Alex has in review to done and leave a comment summarizing it."<br>"Plan the next sprint from the backlog, prioritizing bugs."</p>
    </div>
  </div>`;
  $$('[data-copy]', root).forEach(b => b.onclick = async () => { await window.taskflow.copy(b.dataset.copy === 'cli' ? cli : cfg); toast('Copied to clipboard'); });
  $('#openData').onclick = () => window.taskflow.openDataDir();
}

// ---------------- Modals ----------------
function openModal(html, kind, wide = false) {
  S.modalKind = kind;
  const m = $('#modal');
  m.className = `modal${wide ? ' wide' : ''}`;
  m.innerHTML = html;
  $('#modalBackdrop').classList.remove('hidden');
  $$('[data-close]', m).forEach(b => b.onclick = closeModal);
}
function closeModal() {
  $('#modalBackdrop').classList.add('hidden');
  $('#modal').innerHTML = '';
  S.modalKind = null; S.openIssueId = null;
  if (S.confirmResolve) { S.confirmResolve(false); S.confirmResolve = null; }
}
$('#modalBackdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });

function confirmModal(title, body, okLabel = 'Confirm', danger = false) {
  return new Promise(resolve => {
    openModal(`<div class="modal-head"><h2>${title}</h2></div><div class="modal-body"><p>${esc(body)}</p></div>
      <div class="modal-foot"><button class="btn btn-subtle" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="cOk">${esc(okLabel)}</button></div>`, 'confirm');
    S.confirmResolve = resolve;
    $('#cOk').focus();
    $('#cOk').onclick = () => { S.confirmResolve = null; closeModal(); resolve(true); };
  });
}

function openCreateIssue(defaults = {}) {
  if (!project()) return openCreateProject();
  const d = { type: 'task', priority: 'medium', status: 'todo', ...defaults };
  const sprints = projectSprints().filter(s => s.state !== 'completed');
  openModal(`
    <div class="modal-head"><h2>Create issue</h2></div>
    <div class="modal-body">
      <div class="row">
        <div class="field"><label>Project <span class="req">*</span></label><select class="select" id="ciProject">${S.data.projects.map(p => opt(p.id, `${p.name} (${p.key})`, p.id === S.projectId)).join('')}</select></div>
        <div class="field"><label>Issue type <span class="req">*</span></label><select class="select" id="ciType">${TYPES.map(t => opt(t, cap(t), t === d.type)).join('')}</select></div>
      </div>
      <div class="field"><label>Summary <span class="req">*</span></label><input class="input" id="ciTitle" /></div>
      <div class="field"><label>Description</label><textarea class="textarea" id="ciDesc" placeholder="Supports **bold**, \`code\`, - lists and links"></textarea></div>
      <div class="row">
        <div class="field"><label>Status</label><select class="select" id="ciStatus">${STATUSES.map(s => opt(s, STATUS_LABELS[s], s === d.status)).join('')}</select></div>
        <div class="field"><label>Priority</label><select class="select" id="ciPriority">${PRIORITIES.map(p => opt(p, cap(p), p === d.priority)).join('')}</select></div>
      </div>
      <div class="row">
        <div class="field"><label>Assignee</label><select class="select" id="ciAssignee">${opt('', 'Unassigned')}${S.data.users.map(u => opt(u, u)).join('')}</select></div>
        <div class="field"><label>Story points</label><input class="input" type="number" min="0" step="1" id="ciPoints" /></div>
      </div>
      <div class="row">
        <div class="field"><label>Sprint</label><select class="select" id="ciSprint">${opt('', 'Backlog')}${sprints.map(s => opt(s.id, `${s.name}${s.state === 'active' ? ' (active)' : ''}`, s.id === d.sprintId)).join('')}</select></div>
        <div class="field"><label>Epic</label><select class="select" id="ciEpic">${opt('', 'None')}${epics().map(e => opt(e.id, `${e.key} ${e.title}`)).join('')}</select></div>
      </div>
      <div class="row">
        <div class="field"><label>Labels</label><input class="input" id="ciLabels" placeholder="comma, separated" /></div>
        <div class="field"><label>Due date</label><input class="input" type="date" id="ciDue" /></div>
      </div>
    </div>
    <div class="modal-foot"><label class="muted" style="margin-right:auto;display:flex;gap:6px;align-items:center"><input type="checkbox" id="ciMore" /> Create another</label>
      <button class="btn btn-subtle" data-close>Cancel</button><button class="btn btn-primary" id="ciCreate">Create</button></div>`, 'form');
  $('#ciTitle').focus();
  $('#ciProject').onchange = () => { const keep = { ...d, type: $('#ciType').value }; S.projectId = $('#ciProject').value; store.set('projectId', S.projectId); render(); openCreateIssue({ ...keep, sprintId: undefined }); };
  const submit = async () => {
    const pts = $('#ciPoints').value;
    const issue = await call('createIssue', {
      project: $('#ciProject').value, type: $('#ciType').value, title: $('#ciTitle').value, description: $('#ciDesc').value,
      status: $('#ciStatus').value, priority: $('#ciPriority').value, assignee: $('#ciAssignee').value || null,
      storyPoints: pts === '' ? null : Number(pts), sprintId: $('#ciSprint').value || null, epicId: $('#ciEpic').value || null,
      labels: $('#ciLabels').value.split(',').map(s => s.trim()).filter(Boolean), dueDate: $('#ciDue').value || null,
    });
    toast(`${issue.key} created`);
    if ($('#ciMore').checked) { $('#ciTitle').value = ''; $('#ciDesc').value = ''; $('#ciTitle').focus(); await load(); }
    else { closeModal(); await load(); }
  };
  $('#ciCreate').onclick = submit;
  $('#ciTitle').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
}

// ---------------- Issue detail ----------------
function openIssue(id) {
  S.openIssueId = id;
  openModal('', 'issue', true);
  renderIssueDetail();
}
function renderIssueDetail() {
  const i = issueById(S.openIssueId);
  if (!i) return closeModal();
  const p = S.data.projects.find(x => x.id === i.projectId);
  const epic = i.epicId && issueById(i.epicId);
  const comments = S.data.comments.filter(c => c.issueId === i.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const children = i.type === 'epic' ? S.data.issues.filter(x => x.epicId === i.id).sort(byOrder) : [];
  const sprints = S.data.sprints.filter(s => s.projectId === i.projectId && (s.state !== 'completed' || s.id === i.sprintId));
  const projEpics = S.data.issues.filter(x => x.projectId === i.projectId && x.type === 'epic' && x.id !== i.id);
  const users = [...new Set([...S.data.users, i.assignee, i.reporter].filter(Boolean))];
  const m = $('#modal');
  m.innerHTML = `
    <div class="detail-top">
      <span class="crumb">${esc(p.name)}</span> /
      ${epic ? `<span class="crumb link" data-open="${epic.id}" style="cursor:pointer">${typeIcon('epic')}${esc(epic.key)}</span> /` : ''}
      <span class="crumb">${typeIcon(i.type)}${esc(i.key)}</span>
      <span class="spacer"></span>
      <button class="icon-btn" id="dCopy" title="Copy key"><svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg></button>
      <button class="icon-btn" id="dDelete" title="Delete issue"><svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg></button>
      <button class="icon-btn" data-close title="Close (Esc)"><svg width="18" height="18" viewBox="0 0 24 24"><path fill="currentColor" d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></button>
    </div>
    <div class="detail">
      <div>
        <textarea class="detail-title" id="dTitle" rows="1">${esc(i.title)}</textarea>
        <h3>Description</h3>
        <div id="descWrap"><div class="desc-view" id="descView">${i.description ? miniMarkdown(i.description) : '<span class="desc-empty">Add a description...</span>'}</div></div>
        ${i.type === 'epic' ? `<h3>Child issues (${children.length})</h3>
          ${children.length ? `<div class="children">${children.map(c => `<div class="child" data-open="${c.id}">${typeIcon(c.type)}<span class="muted" style="width:70px">${esc(c.key)}</span><span style="flex:1">${esc(c.title)}</span>${avatar(c.assignee)}${lozenge(c.status)}</div>`).join('')}</div>` : '<div class="muted">No child issues. Set this epic on an issue to link it.</div>'}
          <button class="btn btn-sm" style="margin-top:8px" id="dAddChild">+ Add child issue</button>` : ''}
        <h3>Activity</h3>
        <div class="comment-box">${avatar('Me', 'lg')}<div style="flex:1"><textarea class="textarea" id="dComment" placeholder="Add a comment..."></textarea>
          <div style="margin-top:6px"><button class="btn btn-primary btn-sm" id="dCommentSave">Save</button> <span class="muted" style="font-size:12px">Ctrl+Enter to save</span></div></div></div>
        ${comments.map(c => `<div class="comment">${avatar(c.author, 'lg')}<div style="flex:1">
          <div>${c.author === 'Claude' ? '<span class="claude-badge">AI</span>' : ''}<span class="who">${esc(c.author)}</span><span class="when" title="${fmtDateTime(c.createdAt)}">${timeAgo(c.createdAt)}</span></div>
          <div class="body">${esc(c.body)}</div>
          <div class="actions"><button data-del-comment="${c.id}">Delete</button></div></div></div>`).join('')}
      </div>
      <div>
        <select class="status-select lz-${i.status}" id="dStatus">${STATUSES.map(s => opt(s, STATUS_LABELS[s], s === i.status)).join('')}</select>
        <div class="details-box">
          <div class="dh">Details</div>
          <div class="dgrid">
            <label>Assignee</label><select class="select" data-field="assignee">${opt('', 'Unassigned')}${users.map(u => opt(u, u, u === i.assignee)).join('')}${opt('__new', '+ Add person...')}</select>
            <label>Reporter</label><select class="select" data-field="reporter">${users.map(u => opt(u, u, u === i.reporter)).join('')}</select>
            <label>Type</label><select class="select" data-field="type">${TYPES.map(t => opt(t, cap(t), t === i.type)).join('')}</select>
            <label>Priority</label><select class="select" data-field="priority">${PRIORITIES.map(x => opt(x, cap(x), x === i.priority)).join('')}</select>
            <label>Labels</label><input class="input" data-field="labels" value="${esc(i.labels.join(', '))}" placeholder="None" />
            <label>Story points</label><input class="input" type="number" min="0" data-field="storyPoints" value="${i.storyPoints ?? ''}" placeholder="None" />
            ${i.type !== 'epic' ? `<label>Sprint</label><select class="select" data-field="sprintId">${opt('', 'Backlog')}${sprints.map(s => opt(s.id, s.name, s.id === i.sprintId)).join('')}</select>
            <label>Epic</label><select class="select" data-field="epicId">${opt('', 'None')}${projEpics.map(e => opt(e.id, `${e.key} ${e.title}`, e.id === i.epicId)).join('')}</select>` : ''}
            <label>Due date</label><input class="input" type="date" data-field="dueDate" value="${esc(i.dueDate || '')}" />
          </div>
        </div>
        ${linkedPanel(i)}
        <div class="timestamps">Created ${fmtDateTime(i.createdAt)}<br>Updated ${fmtDateTime(i.updatedAt)}</div>
      </div>
    </div>`;
  $$('[data-close]', m).forEach(b => b.onclick = closeModal);
  $$('[data-open]', m).forEach(el => el.onclick = () => openIssue(el.dataset.open));

  const title = $('#dTitle');
  const fit = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  requestAnimationFrame(fit);
  title.oninput = fit;
  title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { e.stopPropagation(); title.value = i.title; title.blur(); } };
  title.onblur = async () => { if (title.value.trim() && title.value.trim() !== i.title) await mutate('updateIssue', i.id, { title: title.value }); else if (!title.value.trim()) title.value = i.title; };

  $('#descView').onclick = (e) => {
    if (e.target.tagName === 'A') return;
    $('#descWrap').innerHTML = `<div class="desc-edit"><textarea class="textarea" id="dDesc" style="min-height:160px">${esc(i.description)}</textarea>
      <div style="margin-top:6px;display:flex;gap:6px"><button class="btn btn-primary btn-sm" id="dDescSave">Save</button><button class="btn btn-subtle btn-sm" id="dDescCancel">Cancel</button></div></div>`;
    const ta = $('#dDesc'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    $('#dDescSave').onclick = async () => { const v = ta.value; $('#descWrap').innerHTML = ''; await mutate('updateIssue', i.id, { description: v }); renderIssueDetail(); };
    $('#dDescCancel').onclick = () => renderIssueDetail();
    ta.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); renderIssueDetail(); } if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) $('#dDescSave').click(); };
  };

  $('#dStatus').onchange = (e) => mutate('updateIssue', i.id, { status: e.target.value });
  $$('[data-field]', m).forEach(el => {
    el.onchange = async () => {
      const f = el.dataset.field;
      let v = el.value;
      if (f === 'assignee' && v === '__new') {
        el.value = i.assignee || '';
        return promptPerson(async (name) => { await call('addUser', name); await mutate('updateIssue', i.id, { assignee: name }); });
      }
      if (f === 'labels') v = v.split(',').map(s => s.trim()).filter(Boolean);
      if (f === 'storyPoints') v = v === '' ? null : Number(v);
      if (f === 'assignee' || f === 'sprintId' || f === 'epicId') v = v || null;
      await mutate('updateIssue', i.id, { [f]: v });
    };
    if (el.tagName === 'INPUT' && el.type !== 'date') el.onkeydown = (e) => { if (e.key === 'Enter') el.blur(); };
  });

  const saveComment = async () => {
    const ta = $('#dComment');
    if (!ta.value.trim()) return;
    const body = ta.value; ta.value = ''; ta.blur();
    await mutate('addComment', i.id, body, 'Me');
  };
  $('#dCommentSave').onclick = saveComment;
  $('#dComment').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveComment(); };
  $$('[data-del-comment]', m).forEach(b => b.onclick = () => mutate('deleteComment', b.dataset.delComment));
  $('#dCopy').onclick = async () => { await window.taskflow.copy(i.key); toast(`${i.key} copied`); };
  $('#dAddChild')?.addEventListener('click', () => { const pid = i.projectId; closeModal(); S.projectId = pid; openCreateIssue({ type: 'story' }); setTimeout(() => { $('#ciEpic').value = i.id; }, 0); });
  $('#dDelete').onclick = async () => {
    if (await confirmModal(`Delete ${esc(i.key)}?`, `"${i.title}" and its comments will be permanently deleted.`, 'Delete', true)) {
      await mutate('deleteIssue', i.id); toast(`${i.key} deleted`);
    } else openIssue(i.id);
  };
}
function promptPerson(onOk) {
  const back = S.openIssueId;
  openModal(`<div class="modal-head"><h2>Add person</h2></div><div class="modal-body"><div class="field"><label>Name</label><input class="input" id="ppName" /></div></div>
    <div class="modal-foot"><button class="btn btn-subtle" id="ppCancel">Cancel</button><button class="btn btn-primary" id="ppOk">Add</button></div>`, 'form');
  const done = async (ok) => { const v = $('#ppName').value.trim(); if (ok && v) await onOk(v); openIssue(back); };
  $('#ppName').focus();
  $('#ppOk').onclick = () => done(true);
  $('#ppCancel').onclick = () => done(false);
  $('#ppName').onkeydown = (e) => e.key === 'Enter' && done(true);
}

// ---------------- Global search ----------------
(function setupSearch() {
  const input = $('#globalSearch'), box = $('#searchResults');
  let sel = 0, results = [];
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { box.classList.add('hidden'); return; }
    results = S.data.issues.filter(i => `${i.key} ${i.title}`.toLowerCase().includes(q)).slice(0, 12);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    box.innerHTML = results.length ? results.map((i, n) => `<div class="search-item ${n === sel ? 'sel' : ''}" data-id="${i.id}">${typeIcon(i.type)}<span class="key">${esc(i.key)}</span><span class="t">${esc(i.title)}</span>${lozenge(i.status)}</div>`).join('') : '<div class="search-item muted">No matching issues</div>';
    box.classList.remove('hidden');
    $$('[data-id]', box).forEach(el => el.onmousedown = (e) => { e.preventDefault(); pick(el.dataset.id); });
  };
  const pick = (id) => { const i = issueById(id); input.value = ''; box.classList.add('hidden'); input.blur(); if (i.projectId !== S.projectId) selectProject(i.projectId); openIssue(id); };
  input.oninput = () => { sel = 0; draw(); };
  input.onblur = () => box.classList.add('hidden');
  input.onfocus = draw;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter' && results[sel]) pick(results[sel].id);
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  };
})();

// ---------------- global wiring ----------------
$('#createBtn').onclick = () => openCreateIssue({ sprintId: S.view === 'board' ? activeSprint()?.id : undefined });
$$('.topnav-item').forEach(b => b.onclick = () => go(b.dataset.nav));
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === 'Escape' && S.modalKind) { closeModal(); return; }
  if (typing || S.modalKind || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'c') { e.preventDefault(); $('#createBtn').click(); }
  if (e.key === '/') { e.preventDefault(); $('#globalSearch').focus(); }
});

load();
