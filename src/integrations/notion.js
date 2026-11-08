// Notion connector: syncs a TaskFlow project with a Notion database.
// Missing properties are added to the database automatically.
'use strict';
const { cap, statusFromName, typeFromName, priorityFromName, http, STATUSES, STATUS_LABELS, TYPES, PRIORITIES } = require('./util');

const API = 'https://api.notion.com/v1';
const PROPS = {
  status: { name: 'Status', type: 'select', create: { select: { options: STATUSES.map(s => ({ name: STATUS_LABELS[s] })) } } },
  type: { name: 'Type', type: 'select', create: { select: { options: TYPES.map(t => ({ name: cap(t) })) } } },
  priority: { name: 'Priority', type: 'select', create: { select: { options: PRIORITIES.map(p => ({ name: cap(p) })) } } },
  assignee: { name: 'Assignee', type: 'rich_text', create: { rich_text: {} } },
  labels: { name: 'Labels', type: 'multi_select', create: { multi_select: {} } },
  storyPoints: { name: 'Story Points', type: 'number', create: { number: {} } },
  dueDate: { name: 'Due', type: 'date', create: { date: {} } },
  description: { name: 'Description', type: 'rich_text', create: { rich_text: {} } },
};

const plain = (rt) => (rt || []).map(t => t.plain_text ?? t.text?.content ?? '').join('');
const rich = (s) => { const str = String(s || ''); const out = []; for (let i = 0; i < str.length; i += 2000) out.push({ type: 'text', text: { content: str.slice(i, i + 2000) } }); return out; };

class NotionAdapter {
  constructor({ token, databaseId }, fetchImpl = fetch) {
    if (!token || !databaseId) throw new Error('Notion needs an integration secret and a database ID');
    // Accept a full database URL or a bare id.
    const m = String(databaseId).replace(/-/g, '').match(/[0-9a-f]{32}/i);
    if (!m) throw new Error('Could not find a 32-character database ID in what you entered');
    this.dbId = m[0];
    this.token = String(token).trim();
    this.fetch = fetchImpl;
    this.fields = ['title'];
  }
  req(method, path, body) {
    return http(this.fetch, API + path, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }, 'Notion');
  }
  async test() {
    const db = await this.req('GET', `/databases/${this.dbId}`);
    return `Connected to Notion database "${plain(db.title) || 'Untitled'}"`;
  }
  async init() {
    let db = await this.req('GET', `/databases/${this.dbId}`);
    const props = db.properties || {};
    const missing = {};
    for (const [field, spec] of Object.entries(PROPS)) if (!props[spec.name]) missing[spec.name] = spec.create;
    if (Object.keys(missing).length) db = await this.req('PATCH', `/databases/${this.dbId}`, { properties: missing });
    this.props = db.properties;
    this.titleProp = Object.entries(this.props).find(([, p]) => p.type === 'title')[0];
    this.map = {}; // field -> { name, type }
    this.fields = ['title'];
    for (const [field, spec] of Object.entries(PROPS)) {
      const p = this.props[spec.name];
      if (!p) continue;
      const ok = p.type === spec.type || (field === 'status' && p.type === 'status') || (field === 'assignee' && p.type === 'people');
      if (ok) { this.map[field] = { name: spec.name, type: p.type, prop: p }; this.fields.push(field); }
    }
    // A "people" Assignee can be read but not written by name.
    this.readOnly = new Set(this.map.assignee?.type === 'people' ? ['assignee'] : []);
  }
  toItem(page) {
    const P = page.properties;
    const get = (field) => { const m = this.map[field]; return m ? P[m.name] : undefined; };
    const f = { title: plain(P[this.titleProp]?.title) };
    if (this.map.description) f.description = plain(get('description')?.rich_text);
    if (this.map.status) { const v = get('status'); f.status = statusFromName(v?.select?.name || v?.status?.name); }
    if (this.map.type) f.type = typeFromName(get('type')?.select?.name);
    if (this.map.priority) f.priority = priorityFromName(get('priority')?.select?.name);
    if (this.map.assignee) { const v = get('assignee'); f.assignee = v?.type === 'people' ? (v.people?.[0]?.name || null) : (plain(v?.rich_text) || null); }
    if (this.map.labels) f.labels = (get('labels')?.multi_select || []).map(o => o.name);
    if (this.map.storyPoints) f.storyPoints = get('storyPoints')?.number ?? null;
    if (this.map.dueDate) f.dueDate = get('dueDate')?.date?.start || null;
    return { extId: page.id, url: page.url, updatedAt: page.last_edited_time, fields: f };
  }
  async list() {
    const out = [];
    let cursor;
    do {
      const res = await this.req('POST', `/databases/${this.dbId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      out.push(...res.results.filter(p => !p.archived && !p.in_trash).map(p => this.toItem(p)));
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return out;
  }
  statusValue(status) {
    const m = this.map.status;
    if (m.type === 'select') return { select: { name: STATUS_LABELS[status] } };
    // Native Notion "Status" property: options can't be created over the API, so pick the closest existing one.
    const opt = (m.prop.status?.options || []).find(o => statusFromName(o.name) === status);
    return opt ? { status: { name: opt.name } } : null;
  }
  buildProps(f, keys) {
    const props = {}; const warn = [];
    for (const k of keys) {
      if (this.readOnly.has(k)) { warn.push(`Notion "${this.map[k].name}" is a People property; set the assignee in Notion`); continue; }
      if (k === 'title') props[this.titleProp] = { title: rich(f.title) };
      const m = this.map[k];
      if (!m) continue;
      if (k === 'description') props[m.name] = { rich_text: rich(f.description) };
      if (k === 'status') { const v = this.statusValue(f.status); if (v) props[m.name] = v; else warn.push(`no Notion status option matches "${STATUS_LABELS[f.status]}"`); }
      if (k === 'type') props[m.name] = { select: { name: cap(f.type) } };
      if (k === 'priority') props[m.name] = { select: { name: cap(f.priority) } };
      if (k === 'assignee') props[m.name] = { rich_text: rich(f.assignee || '') };
      if (k === 'labels') props[m.name] = { multi_select: f.labels.map(name => ({ name: name.replace(/,/g, ' ') })) };
      if (k === 'storyPoints') props[m.name] = { number: f.storyPoints };
      if (k === 'dueDate') props[m.name] = { date: f.dueDate ? { start: f.dueDate } : null };
    }
    return { props, warning: warn.join('; ') || undefined };
  }
  async create(f) {
    const { props, warning } = this.buildProps(f, this.fields);
    const page = await this.req('POST', '/pages', { parent: { database_id: this.dbId }, properties: props });
    return { extId: page.id, url: page.url, warning };
  }
  async update(id, f, keys) {
    const { props, warning } = this.buildProps(f, keys);
    if (Object.keys(props).length) await this.req('PATCH', `/pages/${id}`, { properties: props });
    return { warning };
  }
}
module.exports = { NotionAdapter };
