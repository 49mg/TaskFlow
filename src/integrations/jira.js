// Jira Cloud connector (REST API v3, email + API token).
'use strict';
const { cap, statusFromName, typeFromName, priorityFromName, adfToText, textToAdf, http, STATUS_LABELS } = require('./util');

class JiraAdapter {
  constructor({ site, email, token, projectKey }, fetchImpl = fetch) {
    if (!site || !email || !token || !projectKey) throw new Error('Jira needs site URL, email, API token and project key');
    let s = String(site).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(s)) s = 'https://' + s;
    this.site = s; this.projectKey = String(projectKey).trim().toUpperCase();
    this.auth = 'Basic ' + Buffer.from(`${String(email).trim()}:${String(token).trim()}`).toString('base64');
    this.fetch = fetchImpl;
    this.fields = ['title', 'description', 'status', 'type', 'priority', 'labels', 'assignee', 'dueDate'];
    this.userCache = new Map();
  }
  req(method, path, body) {
    return http(this.fetch, this.site + path, {
      method, headers: { Authorization: this.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, 'Jira');
  }
  async test() {
    const p = await this.req('GET', `/rest/api/3/project/${encodeURIComponent(this.projectKey)}`);
    return `Connected to Jira project "${p.name}" (${p.key})`;
  }
  async init() { await this.test(); }

  // Jira labels cannot contain spaces.
  normalize(f) { if (f.labels) f.labels = [...new Set(f.labels.map(l => l.replace(/\s+/g, '-')))].sort(); return f; }

  toItem(i) {
    const f = i.fields;
    return {
      extId: i.id, url: `${this.site}/browse/${i.key}`, updatedAt: f.updated,
      fields: {
        title: f.summary, description: adfToText(f.description), status: statusFromName(f.status?.name, f.status?.statusCategory?.key),
        type: typeFromName(f.issuetype?.name), priority: priorityFromName(f.priority?.name), labels: f.labels || [],
        assignee: f.assignee?.displayName || null, dueDate: f.duedate || null,
      },
    };
  }
  async list() {
    const out = [];
    let nextPageToken;
    do {
      const res = await this.req('POST', '/rest/api/3/search/jql', {
        jql: `project = "${this.projectKey}" ORDER BY created ASC`, maxResults: 100, nextPageToken,
        fields: ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'assignee', 'duedate', 'updated'],
      });
      out.push(...(res.issues || []).map(i => this.toItem(i)));
      nextPageToken = res.isLast === false || res.nextPageToken ? res.nextPageToken : undefined;
    } while (nextPageToken);
    return out;
  }
  async accountId(name) {
    if (!name) return null;
    if (this.userCache.has(name)) return this.userCache.get(name);
    const users = await this.req('GET', `/rest/api/3/user/assignable/search?project=${encodeURIComponent(this.projectKey)}&query=${encodeURIComponent(name)}&maxResults=20`);
    const u = (users || []).find(x => x.displayName?.toLowerCase() === name.toLowerCase());
    this.userCache.set(name, u?.accountId || undefined);
    return u?.accountId;
  }
  async buildFields(f, keys) {
    const out = {}; const warn = [];
    for (const k of keys) {
      if (k === 'title') out.summary = f.title;
      if (k === 'description') out.description = textToAdf(f.description);
      if (k === 'type') out.issuetype = { name: cap(f.type) };
      if (k === 'priority') out.priority = { name: cap(f.priority) };
      if (k === 'labels') out.labels = f.labels;
      if (k === 'dueDate') out.duedate = f.dueDate;
      if (k === 'assignee') {
        if (!f.assignee) out.assignee = null;
        else { const id = await this.accountId(f.assignee); if (id) out.assignee = { accountId: id }; else warn.push(`no Jira user named "${f.assignee}", assignee not synced`); }
      }
    }
    return { out, warn };
  }
  async transition(id, status) {
    const { transitions = [] } = await this.req('GET', `/rest/api/3/issue/${id}/transitions`);
    const match = transitions.find(t => statusFromName(t.to?.name || t.name, t.to?.statusCategory?.key) === status);
    if (!match) return `no Jira transition to "${STATUS_LABELS[status]}" available from the current status`;
    await this.req('POST', `/rest/api/3/issue/${id}/transitions`, { transition: { id: match.id } });
    return null;
  }
  async create(f) {
    const { out, warn } = await this.buildFields(f, this.fields.filter(k => k !== 'status'));
    let res;
    try {
      res = await this.req('POST', '/rest/api/3/issue', { fields: { project: { key: this.projectKey }, ...out } });
    } catch (e) {
      if (e.status !== 400) throw e;
      // Retry with the minimum every Jira project accepts (type/priority/labels may not be on the create screen).
      warn.push(`created with reduced fields (${e.message.replace(/^Jira 400: /, '')})`);
      res = await this.req('POST', '/rest/api/3/issue', { fields: { project: { key: this.projectKey }, summary: f.title, description: textToAdf(f.description), issuetype: { name: 'Task' } } });
    }
    if (f.status !== 'todo') { const w = await this.transition(res.id, f.status); if (w) warn.push(w); }
    return { extId: res.id, url: `${this.site}/browse/${res.key}`, warning: warn.join('; ') || undefined };
  }
  async update(id, f, keys) {
    const warn = [];
    const { out, warn: w } = await this.buildFields(f, keys.filter(k => k !== 'status'));
    warn.push(...w);
    if (Object.keys(out).length) await this.req('PUT', `/rest/api/3/issue/${id}`, { fields: out });
    if (keys.includes('status')) { const t = await this.transition(id, f.status); if (t) warn.push(t); }
    return { warning: warn.join('; ') || undefined };
  }
}
module.exports = { JiraAdapter };
