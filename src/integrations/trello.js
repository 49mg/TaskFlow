// Trello connector: a TaskFlow project <-> a Trello board.
// Columns map to lists (created if missing); type and priority are stored as labels
// like "type:bug" and "priority:high" because Trello has no such fields.
'use strict';
const { statusFromName, http, STATUSES, STATUS_LABELS, TYPES, PRIORITIES } = require('./util');

const API = 'https://api.trello.com/1';
const TYPE_COLORS = { task: 'blue', bug: 'red', story: 'green', epic: 'purple' };
const PRIORITY_COLORS = { highest: 'red', high: 'orange', medium: 'yellow', low: 'sky', lowest: 'lime' };

class TrelloAdapter {
  constructor({ apiKey, token, boardId }, fetchImpl = fetch) {
    if (!apiKey || !token || !boardId) throw new Error('Trello needs an API key, a token and a board ID');
    // Accept a board URL (trello.com/b/<shortLink>/name) or a bare id.
    const m = String(boardId).match(/trello\.com\/b\/([^/?#]+)/);
    this.boardId = m ? m[1] : String(boardId).trim();
    this.key = String(apiKey).trim(); this.token = String(token).trim();
    this.fetch = fetchImpl;
    this.fields = ['title', 'description', 'status', 'type', 'priority', 'labels', 'assignee', 'dueDate'];
  }
  req(method, path, body) {
    const sep = path.includes('?') ? '&' : '?';
    return http(this.fetch, `${API}${path}${sep}key=${encodeURIComponent(this.key)}&token=${encodeURIComponent(this.token)}`, {
      method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, 'Trello');
  }
  async test() {
    const b = await this.req('GET', `/boards/${this.boardId}?fields=name`);
    return `Connected to Trello board "${b.name}"`;
  }
  async init() {
    const board = await this.req('GET', `/boards/${this.boardId}?fields=name,id`);
    this.boardRealId = board.id;
    const lists = await this.req('GET', `/boards/${this.boardId}/lists?filter=open`);
    this.listStatus = new Map(lists.map(l => [l.id, statusFromName(l.name)]));
    this.statusList = {};
    for (const s of STATUSES) {
      const exact = lists.find(l => l.name.trim().toLowerCase() === STATUS_LABELS[s].toLowerCase());
      const fuzzy = lists.find(l => statusFromName(l.name) === s);
      let list = exact || fuzzy;
      if (!list) list = await this.req('POST', '/lists', { name: STATUS_LABELS[s], idBoard: board.id, pos: 'bottom' });
      this.statusList[s] = list.id;
      this.listStatus.set(list.id, s);
    }
    this.labels = await this.req('GET', `/boards/${this.boardId}/labels?limit=1000`);
    const members = await this.req('GET', `/boards/${this.boardId}/members?fields=fullName,username`);
    this.members = members || [];
  }
  labelName(id) { return this.labels.find(l => l.id === id)?.name || ''; }
  async labelId(name, color) {
    let l = this.labels.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!l) { l = await this.req('POST', '/labels', { name, color: color || 'sky', idBoard: this.boardRealId }); this.labels.push(l); }
    return l.id;
  }
  toItem(c) {
    const names = (c.idLabels || []).map(id => this.labelName(id)).filter(Boolean);
    const tag = (prefix, list, dflt) => { const n = names.find(x => x.toLowerCase().startsWith(prefix)); const v = n?.slice(prefix.length).trim().toLowerCase(); return list.includes(v) ? v : dflt; };
    const member = this.members.find(m => m.id === c.idMembers?.[0]);
    return {
      extId: c.id, url: c.shortUrl || c.url, updatedAt: c.dateLastActivity, idList: c.idList,
      fields: {
        title: c.name, description: c.desc || '', status: this.listStatus.get(c.idList) || 'todo',
        type: tag('type:', TYPES, 'task'), priority: tag('priority:', PRIORITIES, 'medium'),
        labels: names.filter(n => !/^(type|priority):/i.test(n)),
        assignee: member?.fullName || null, dueDate: c.due ? c.due.slice(0, 10) : null,
      },
    };
  }
  async list() {
    const cards = await this.req('GET', `/boards/${this.boardId}/cards/open?fields=name,desc,idList,idLabels,idMembers,due,dateLastActivity,shortUrl`);
    return cards.map(c => this.toItem(c));
  }
  async labelIds(f) {
    const ids = [await this.labelId(`type:${f.type}`, TYPE_COLORS[f.type]), await this.labelId(`priority:${f.priority}`, PRIORITY_COLORS[f.priority])];
    for (const l of f.labels) ids.push(await this.labelId(l));
    return ids;
  }
  memberIds(name, warn) {
    if (!name) return [];
    const m = this.members.find(x => x.fullName?.toLowerCase() === name.toLowerCase() || x.username?.toLowerCase() === name.toLowerCase());
    if (!m) { warn.push(`"${name}" is not a member of the Trello board, assignee not synced`); return null; }
    return [m.id];
  }
  async create(f) {
    const warn = [];
    const idMembers = this.memberIds(f.assignee, warn);
    const card = await this.req('POST', '/cards', {
      idList: this.statusList[f.status], name: f.title, desc: f.description, pos: 'bottom',
      due: f.dueDate ? `${f.dueDate}T12:00:00.000Z` : null, idLabels: (await this.labelIds(f)).join(','),
      ...(idMembers ? { idMembers: idMembers.join(',') } : {}),
    });
    return { extId: card.id, url: card.shortUrl || card.url, warning: warn.join('; ') || undefined };
  }
  async update(id, f, keys, remote) {
    const warn = []; const body = {};
    if (keys.includes('title')) body.name = f.title;
    if (keys.includes('description')) body.desc = f.description;
    // Only move the card if TaskFlow's status really differs from the list it's in.
    if (keys.includes('status') && this.listStatus.get(remote?.idList) !== f.status) body.idList = this.statusList[f.status];
    if (keys.includes('dueDate')) body.due = f.dueDate ? `${f.dueDate}T12:00:00.000Z` : null;
    if (keys.some(k => k === 'type' || k === 'priority' || k === 'labels')) body.idLabels = (await this.labelIds(f)).join(',');
    if (keys.includes('assignee')) { const ids = this.memberIds(f.assignee, warn); if (ids) body.idMembers = ids.join(','); }
    if (Object.keys(body).length) await this.req('PUT', `/cards/${id}`, body);
    return { warning: warn.join('; ') || undefined };
  }
}
module.exports = { TrelloAdapter };
