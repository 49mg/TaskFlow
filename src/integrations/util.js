// Shared helpers for the Jira / Notion / Trello connectors.
'use strict';

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'];
const STATUS_LABELS = { todo: 'To Do', in_progress: 'In Progress', in_review: 'In Review', done: 'Done' };
const TYPES = ['task', 'bug', 'story', 'epic'];
const PRIORITIES = ['highest', 'high', 'medium', 'low', 'lowest'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Map any external status/list name to a TaskFlow status. `category` is Jira's statusCategory key.
function statusFromName(name, category) {
  const n = String(name || '').toLowerCase();
  if (/review|qa|testing|verify/.test(n)) return 'in_review';
  if (/not started|to ?do|backlog|open|new|selected/.test(n)) return 'todo';
  if (/done|complete|closed|resolved|finished|shipped/.test(n)) return 'done';
  if (/progress|doing|started|active|working/.test(n)) return 'in_progress';
  if (category === 'done') return 'done';
  if (category === 'indeterminate') return 'in_progress';
  return 'todo';
}
const typeFromName = (n) => { const v = String(n || '').toLowerCase(); return TYPES.find(t => v.includes(t)) || 'task'; };
const priorityFromName = (n) => { const v = String(n || '').toLowerCase(); return PRIORITIES.find(p => v === p) || PRIORITIES.find(p => v.includes(p)) || 'medium'; };

function normText(s) {
  return String(s || '').replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Canonical form of the synced fields, so values compare equal across services.
function normalize(f) {
  const out = {};
  if ('title' in f) out.title = String(f.title || '').trim();
  if ('description' in f) out.description = normText(f.description);
  if ('status' in f) out.status = STATUSES.includes(f.status) ? f.status : 'todo';
  if ('type' in f) out.type = TYPES.includes(f.type) ? f.type : 'task';
  if ('priority' in f) out.priority = PRIORITIES.includes(f.priority) ? f.priority : 'medium';
  if ('labels' in f) out.labels = [...new Set((f.labels || []).map(l => String(l).trim()).filter(Boolean))].sort();
  if ('assignee' in f) out.assignee = f.assignee ? String(f.assignee).trim() || null : null;
  if ('dueDate' in f) out.dueDate = f.dueDate ? String(f.dueDate).slice(0, 10) : null;
  if ('storyPoints' in f) out.storyPoints = f.storyPoints == null || f.storyPoints === '' || Number.isNaN(Number(f.storyPoints)) ? null : Number(f.storyPoints);
  return out;
}
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---- Atlassian Document Format <-> plain text ----
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const kids = (n) => (n.content || []).map(adfToText).join('');
  switch (node.type) {
    case 'doc': return (node.content || []).map(adfToText).join('\n').trim();
    case 'paragraph': return kids(node);
    case 'heading': return '# ' + kids(node);
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'bulletList': case 'orderedList': return (node.content || []).map(li => '- ' + (li.content || []).map(adfToText).join(' ')).join('\n');
    case 'codeBlock': return kids(node);
    case 'mention': return node.attrs?.text || '';
    case 'inlineCard': return node.attrs?.url || '';
    default: return kids(node);
  }
}
function textToAdf(text) {
  const content = [];
  let list = null;
  for (const line of normText(text).split('\n')) {
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!list) { list = { type: 'bulletList', content: [] }; content.push(list); }
      list.content.push({ type: 'listItem', content: [{ type: 'paragraph', content: li[1] ? [{ type: 'text', text: li[1] }] : [] }] });
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const h = line.match(/^#{1,3}\s+(.*)/);
    content.push(h ? { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: h[1] }] } : { type: 'paragraph', content: [{ type: 'text', text: line }] });
  }
  return { type: 'doc', version: 1, content };
}

// fetch wrapper with readable errors.
async function http(fetchImpl, url, opts, label) {
  let res;
  try { res = await fetchImpl(url, opts); }
  catch (e) { throw new Error(`${label}: network error (${e.cause?.code || e.message})`); }
  const txt = await res.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  if (!res.ok) {
    let msg = typeof body === 'string' ? body : body?.message || [...(body?.errorMessages || []), ...Object.entries(body?.errors || {}).map(([k, v]) => `${k}: ${v}`)].join('; ') || res.statusText;
    if (res.status === 401) msg = `authentication failed — check your credentials (${msg})`;
    if (res.status === 404) msg = `not found — check the ID/key and that you have access (${msg})`;
    const err = new Error(`${label} ${res.status}: ${String(msg).slice(0, 300)}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

module.exports = { STATUSES, STATUS_LABELS, TYPES, PRIORITIES, cap, statusFromName, typeFromName, priorityFromName, normText, normalize, eq, adfToText, textToAdf, http };
