#!/usr/bin/env node
// TaskFlow MCP server (stdio). Reads/writes the same data file as the desktop app,
// so changes made by Claude show up live in the app and vice versa.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { api, read, documentPath, findProject, findIssue, findSprint, STATUSES, STATUS_LABELS, TYPES, PRIORITIES, DATA_FILE } = require('../src/store');

const server = new McpServer({ name: 'taskflow', version: '1.1.0' });

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message || e}` }] });
const tool = (name, description, inputSchema, handler) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try { return ok(await handler(args || {})); } catch (e) { return fail(e); }
  });

// Turn internal ids into human-friendly references.
function present(data, i) {
  const epic = i.epicId && data.issues.find(x => x.id === i.epicId);
  const sprint = i.sprintId && data.sprints.find(s => s.id === i.sprintId);
  const project = data.projects.find(p => p.id === i.projectId);
  return {
    key: i.key, title: i.title, type: i.type, status: i.status, priority: i.priority,
    assignee: i.assignee, reporter: i.reporter, labels: i.labels, storyPoints: i.storyPoints,
    epic: epic ? epic.key : null, sprint: sprint ? sprint.name : null, project: project?.key,
    dueDate: i.dueDate, description: i.description, createdAt: i.createdAt, updatedAt: i.updatedAt,
    linkedTo: Object.fromEntries(Object.entries(i.links || {}).filter(([, l]) => !l.removed && l.url).map(([k, l]) => [k, l.url])),
  };
}

const status = z.enum(STATUSES);
const type = z.enum(TYPES);
const priority = z.enum(PRIORITIES);

// ---------------- Projects ----------------
tool('list_projects', 'List all projects with issue counts.', {}, () => {
  const d = read();
  return d.projects.map(p => {
    const issues = d.issues.filter(i => i.projectId === p.id);
    return {
      key: p.key, name: p.name, description: p.description, lead: p.lead, totalIssues: issues.length,
      byStatus: Object.fromEntries(STATUSES.map(s => [s, issues.filter(i => i.status === s).length])),
      activeSprint: d.sprints.find(s => s.projectId === p.id && s.state === 'active')?.name || null,
    };
  });
});

tool('create_project', 'Create a new project. The key prefixes issue keys (e.g. key "WEB" -> WEB-1).', {
  key: z.string().describe('2-10 uppercase letters/digits, e.g. "WEB"'),
  name: z.string(),
  description: z.string().optional(),
  lead: z.string().optional(),
}, (a) => api.createProject(a));

// ---------------- Issues ----------------
tool('list_issues', 'Search issues. All filters are optional and combined with AND.', {
  project: z.string().optional().describe('Project key or name'),
  status: status.optional(),
  type: type.optional(),
  priority: priority.optional(),
  assignee: z.string().optional().describe('Assignee name; use "unassigned" for none'),
  sprint: z.string().optional().describe('Sprint name, "active" for the active sprint, or "backlog" for issues in no sprint'),
  epic: z.string().optional().describe('Epic issue key'),
  label: z.string().optional(),
  query: z.string().optional().describe('Text search in key, title and description'),
  limit: z.number().int().positive().optional().describe('Max results (default 50)'),
}, (a) => {
  const d = read();
  let list = d.issues;
  let project;
  if (a.project) { project = findProject(d, a.project); list = list.filter(i => i.projectId === project.id); }
  if (a.status) list = list.filter(i => i.status === a.status);
  if (a.type) list = list.filter(i => i.type === a.type);
  if (a.priority) list = list.filter(i => i.priority === a.priority);
  if (a.assignee) list = a.assignee.toLowerCase() === 'unassigned' ? list.filter(i => !i.assignee) : list.filter(i => (i.assignee || '').toLowerCase() === a.assignee.toLowerCase());
  if (a.label) list = list.filter(i => i.labels.includes(a.label));
  if (a.epic) { const e = findIssue(d, a.epic); list = list.filter(i => i.epicId === e.id); }
  if (a.sprint) {
    const s = a.sprint.toLowerCase();
    if (s === 'backlog') list = list.filter(i => !i.sprintId && i.type !== 'epic');
    else if (s === 'active') { const ids = new Set(d.sprints.filter(x => x.state === 'active' && (!project || x.projectId === project.id)).map(x => x.id)); list = list.filter(i => ids.has(i.sprintId)); }
    else { const sp = findSprint(d, a.sprint, project?.id); list = list.filter(i => i.sprintId === sp.id); }
  }
  if (a.query) { const q = a.query.toLowerCase(); list = list.filter(i => `${i.key} ${i.title} ${i.description}`.toLowerCase().includes(q)); }
  const total = list.length;
  const issues = list.slice(0, a.limit || 50).map(i => {
    const { description, ...rest } = present(d, i);
    return rest;
  });
  return { total, showing: issues.length, issues };
});

tool('get_issue', 'Get full details of an issue, including description, comments and child issues (for epics).', {
  key: z.string().describe('Issue key, e.g. "DEMO-3"'),
}, ({ key }) => {
  const d = read();
  const i = findIssue(d, key);
  return {
    ...present(d, i),
    comments: d.comments.filter(c => c.issueId === i.id).map(c => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })),
    children: i.type === 'epic' ? d.issues.filter(x => x.epicId === i.id).map(x => ({ key: x.key, title: x.title, status: x.status })) : undefined,
  };
});

const issueFields = {
  title: z.string(),
  description: z.string().optional().describe('Markdown-ish plain text'),
  type: type.optional(),
  status: status.optional(),
  priority: priority.optional(),
  assignee: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  storyPoints: z.number().nullable().optional(),
  epic: z.string().nullable().optional().describe('Epic issue key to link under'),
  sprint: z.string().nullable().optional().describe('Sprint name; null for backlog'),
  dueDate: z.string().nullable().optional().describe('YYYY-MM-DD'),
};

tool('create_issue', 'Create an issue (task, bug, story or epic) in a project.', {
  project: z.string().describe('Project key or name'),
  ...issueFields,
  reporter: z.string().optional(),
}, (a) => { const i = api.createIssue({ ...a, reporter: a.reporter || 'Claude' }); return present(read(), i); });

tool('update_issue', 'Update fields of an existing issue. Only the provided fields change.', {
  key: z.string(),
  ...Object.fromEntries(Object.entries(issueFields).map(([k, v]) => [k, v.optional()])),
}, ({ key, ...patch }) => { const i = api.updateIssue(key, patch); return present(read(), i); });

tool('transition_issue', `Move an issue to another workflow status (${STATUSES.map(s => `${s}="${STATUS_LABELS[s]}"`).join(', ')}).`, {
  key: z.string(),
  status,
}, ({ key, status }) => { const i = api.updateIssue(key, { status }); return `${i.key} moved to ${STATUS_LABELS[i.status]}`; });

tool('assign_issue', 'Assign an issue to a person (or pass null to unassign).', {
  key: z.string(),
  assignee: z.string().nullable(),
}, ({ key, assignee }) => { const i = api.updateIssue(key, { assignee }); return `${i.key} assigned to ${i.assignee || 'nobody'}`; });

tool('delete_issue', 'Permanently delete an issue and its comments.', { key: z.string() }, ({ key }) => api.deleteIssue(key));

tool('add_comment', 'Add a comment to an issue.', {
  key: z.string(),
  body: z.string(),
  author: z.string().optional().describe('Defaults to "Claude"'),
}, ({ key, body, author }) => api.addComment(key, body, author || 'Claude'));

// ---------------- Sprints / board ----------------
tool('list_sprints', 'List sprints for a project with progress.', { project: z.string() }, ({ project }) => {
  const d = read();
  const p = findProject(d, project);
  return d.sprints.filter(s => s.projectId === p.id).map(s => {
    const issues = d.issues.filter(i => i.sprintId === s.id);
    return { name: s.name, state: s.state, goal: s.goal, startDate: s.startDate, endDate: s.endDate, issues: issues.length, done: issues.filter(i => i.status === 'done').length, storyPoints: issues.reduce((n, i) => n + (i.storyPoints || 0), 0) };
  });
});

tool('create_sprint', 'Create a planned sprint in a project.', {
  project: z.string(), name: z.string().optional(), goal: z.string().optional(),
}, (a) => api.createSprint(a));

tool('start_sprint', 'Start a planned sprint (only one active sprint per project).', { sprint: z.string().describe('Sprint name') }, ({ sprint }) => api.startSprint(sprint));

tool('complete_sprint', 'Complete the active sprint. Unfinished issues move back to the backlog.', { sprint: z.string() }, ({ sprint }) => api.completeSprint(sprint));

tool('move_to_sprint', 'Move issues into a sprint, or to the backlog with sprint=null.', {
  keys: z.array(z.string()).describe('Issue keys'),
  sprint: z.string().nullable(),
}, ({ keys, sprint }) => keys.map(k => { const i = api.updateIssue(k, { sprint }); return `${i.key} -> ${sprint || 'Backlog'}`; }).join('\n'));

tool('get_board', 'Get the board for a project: issues of the active sprint (or all non-epic issues if no sprint is active) grouped by column.', {
  project: z.string(),
}, ({ project }) => {
  const d = read();
  const p = findProject(d, project);
  const sprint = d.sprints.find(s => s.projectId === p.id && s.state === 'active');
  const issues = d.issues.filter(i => i.projectId === p.id && i.type !== 'epic' && (!sprint || i.sprintId === sprint.id));
  return {
    project: p.key, sprint: sprint ? { name: sprint.name, goal: sprint.goal } : null,
    columns: Object.fromEntries(STATUSES.map(s => [STATUS_LABELS[s], issues.filter(i => i.status === s).sort((a, b) => a.order - b.order).map(i => `${i.key} [${i.type}/${i.priority}] ${i.title}${i.assignee ? ` (@${i.assignee})` : ''}`)])),
  };
});

// ---------------- Documents ----------------
tool('list_documents', 'List the PDF documents uploaded to a project. Each has a local file path you can read.', {
  project: z.string().describe('Project key or name'),
}, ({ project }) => {
  const d = read();
  const p = findProject(d, project);
  return (d.documents || []).filter(x => x.projectId === p.id).map(x => ({
    id: x.id, name: x.name, fileName: x.fileName, sizeBytes: x.size, uploadedBy: x.uploadedBy, uploadedAt: x.createdAt, path: documentPath(x),
  }));
});

tool('add_document', 'Upload a PDF from a local file path into a project, with a display name.', {
  project: z.string().describe('Project key or name'),
  path: z.string().describe('Absolute path of the PDF on this computer'),
  name: z.string().optional().describe('Display name (defaults to the file name)'),
}, ({ project, path: filePath, name }) => { const doc = api.addDocument({ project, filePath, name, uploadedBy: 'Claude' }); return { ...doc, path: documentPath(doc) }; });

tool('list_users', 'List known people who can be assigned issues.', {}, () => read().users);

tool('add_user', 'Add a person to the shared people list.', { name: z.string() }, ({ name }) => api.addUser(name));

tool('remove_user', 'Remove a person from the shared people list (all projects). Their assigned issues become unassigned.', { name: z.string() }, ({ name }) => api.removeUser(name));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`TaskFlow MCP server running. Data: ${DATA_FILE}`);
}
main().catch(e => { console.error(e); process.exit(1); });
