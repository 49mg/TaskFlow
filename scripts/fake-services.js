// In-memory fakes of the Jira, Notion and Trello REST APIs (used by tests).
const json = (status, body) => status === 204 ? new Response(null, { status }) : new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let tick = 0; const now = () => new Date(Date.now() + (++tick) * 1000).toISOString();
let n = 1000;

// ---------------- fake Jira ----------------
function fakeJira() {
  const cat = { 'To Do': 'new', 'In Progress': 'indeterminate', 'In Review': 'indeterminate', 'Done': 'done' };
  const st = (name) => ({ name, statusCategory: { key: cat[name] } });
  const issues = new Map();
  const add = (f) => { const id = String(++n); issues.set(id, { id, key: `JR-${id}`, fields: { status: st('To Do'), priority: { name: 'Medium' }, issuetype: { name: 'Task' }, labels: [], assignee: null, duedate: null, description: null, ...f, updated: now() } }); return issues.get(id); };
  add({ summary: 'Remote Jira issue', issuetype: { name: 'Bug' }, priority: { name: 'High' }, description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From Jira' }] }] } });
  const fetch = async (url, o = {}) => {
    const u = new URL(url); const p = u.pathname; const body = o.body ? JSON.parse(o.body) : null;
    if (o.headers?.Authorization !== 'Basic ' + Buffer.from('a@b.c:tok').toString('base64')) return json(401, { errorMessages: ['no auth'] });
    if (p === '/rest/api/3/project/JR') return json(200, { key: 'JR', name: 'Jira Project' });
    if (p === '/rest/api/3/search/jql') return json(200, { issues: [...issues.values()], isLast: true });
    if (p === '/rest/api/3/user/assignable/search') return json(200, [{ displayName: 'Alex', accountId: 'acc-alex' }]);
    if (p === '/rest/api/3/issue' && o.method === 'POST') {
      const f = body.fields; const i = add({ summary: f.summary, description: f.description, issuetype: f.issuetype, priority: f.priority || { name: 'Medium' }, labels: f.labels || [], duedate: f.duedate || null, assignee: f.assignee ? { displayName: 'Alex' } : null });
      return json(201, { id: i.id, key: i.key });
    }
    let m = p.match(/^\/rest\/api\/3\/issue\/(\d+)\/transitions$/);
    if (m) {
      const i = issues.get(m[1]);
      if (o.method === 'POST') { i.fields.status = st(Object.keys(cat)[Number(body.transition.id)]); i.fields.updated = now(); return json(204); }
      return json(200, { transitions: Object.keys(cat).map((name, id) => ({ id: String(id), name: `Move to ${name}`, to: st(name) })) });
    }
    m = p.match(/^\/rest\/api\/3\/issue\/(\d+)$/);
    if (m && o.method === 'PUT') {
      const i = issues.get(m[1]); const f = body.fields;
      if ('summary' in f) i.fields.summary = f.summary; if ('description' in f) i.fields.description = f.description;
      if ('priority' in f) i.fields.priority = f.priority; if ('issuetype' in f) i.fields.issuetype = f.issuetype;
      if ('labels' in f) i.fields.labels = f.labels; if ('duedate' in f) i.fields.duedate = f.duedate;
      if ('assignee' in f) i.fields.assignee = f.assignee ? { displayName: 'Alex' } : null;
      i.fields.updated = now(); return json(204);
    }
    return json(404, { errorMessages: [`no route ${o.method} ${p}`] });
  };
  return {
    fetch, cfg: { settings: { site: 'acme.atlassian.net', email: 'a@b.c', projectKey: 'JR' }, secrets: { token: 'tok' } },
    remoteSetStatus: (title, s) => { const i = [...issues.values()].find(x => x.fields.summary === title); i.fields.status = st(s); i.fields.updated = now(); },
    remoteTitle: (id) => [...issues.values()].find(x => x.id === id)?.fields.summary,
    remoteDelete: (title) => { const i = [...issues.values()].find(x => x.fields.summary === title); issues.delete(i.id); },
    count: () => issues.size,
  };
}

// ---------------- fake Notion ----------------
function fakeNotion() {
  const DB = 'a'.repeat(32);
  const db = { id: DB, title: [{ plain_text: 'Tasks' }], properties: { Name: { type: 'title' }, Status: { type: 'status', status: { options: [{ name: 'Not started' }, { name: 'In progress' }, { name: 'Done' }] } } } };
  const pages = new Map();
  const fix = (props) => { for (const v of Object.values(props)) for (const k of ['title', 'rich_text']) if (v[k]) v[k] = v[k].map(t => ({ ...t, plain_text: t.text?.content ?? t.plain_text })); return props; };
  const add = (props) => { const id = `page-${++n}`; pages.set(id, { id, url: `https://notion.so/${id}`, archived: false, last_edited_time: now(), properties: fix(props) }); return pages.get(id); };
  add({ Name: { title: [{ text: { content: 'Remote Notion page' } }] }, Status: { status: { name: 'In progress' } } });
  const fetch = async (url, o = {}) => {
    const p = new URL(url).pathname.replace('/v1', ''); const body = o.body ? JSON.parse(o.body) : null;
    if (o.headers?.Authorization !== 'Bearer secret') return json(401, { message: 'API token is invalid.' });
    if (p === `/databases/${DB}` && o.method === 'GET') return json(200, db);
    if (p === `/databases/${DB}` && o.method === 'PATCH') { for (const [k, v] of Object.entries(body.properties)) db.properties[k] = { type: Object.keys(v)[0], ...v }; return json(200, db); }
    if (p === `/databases/${DB}/query`) return json(200, { results: [...pages.values()], has_more: false });
    if (p === '/pages' && o.method === 'POST') return json(200, add(body.properties));
    const m = p.match(/^\/pages\/(.+)$/);
    if (m && o.method === 'PATCH') { const pg = pages.get(m[1]); Object.assign(pg.properties, fix(body.properties)); pg.last_edited_time = now(); return json(200, pg); }
    return json(404, { message: `no route ${o.method} ${p}` });
  };
  return {
    fetch, cfg: { settings: { databaseId: `https://www.notion.so/ws/Tasks-${DB}?v=1` }, secrets: { token: 'secret' } },
    remoteSetStatus: (title, s) => { const pg = [...pages.values()].find(x => x.properties.Name.title[0].plain_text === title); pg.properties.Status = { status: { name: s === 'Done' ? 'Done' : s === 'In Progress' ? 'In progress' : 'Not started' } }; pg.last_edited_time = now(); },
    remoteTitle: (id) => pages.get(id)?.properties.Name.title[0].plain_text,
    remoteDelete: (title) => { const pg = [...pages.values()].find(x => x.properties.Name.title[0].plain_text === title); pg.archived = true; },
    count: () => [...pages.values()].filter(p => !p.archived).length,
  };
}

// ---------------- fake Trello ----------------
function fakeTrello() {
  const board = { id: 'board1', name: 'Board' };
  const lists = [{ id: 'l1', name: 'Backlog' }, { id: 'l2', name: 'Doing' }];
  const labels = []; const cards = new Map();
  const members = [{ id: 'm1', fullName: 'Alex', username: 'alex' }];
  const add = (c) => { const id = `card-${++n}`; cards.set(id, { id, shortUrl: `https://trello.com/c/${id}`, desc: '', idLabels: [], idMembers: [], due: null, ...c, dateLastActivity: now() }); return cards.get(id); };
  add({ name: 'Remote Trello card', idList: 'l2' });
  const csv = (v) => (v ? String(v).split(',').filter(Boolean) : []);
  const fetch = async (url, o = {}) => {
    const u = new URL(url); const p = u.pathname.replace('/1', ''); const body = o.body ? JSON.parse(o.body) : null;
    if (u.searchParams.get('key') !== 'k' || u.searchParams.get('token') !== 't') return json(401, 'invalid key');
    if (p === '/boards/AbCd12') return json(200, board);
    if (p === '/boards/AbCd12/lists') return json(200, lists);
    if (p === '/boards/AbCd12/labels') return json(200, labels);
    if (p === '/boards/AbCd12/members') return json(200, members);
    if (p === '/boards/AbCd12/cards/open') return json(200, [...cards.values()]);
    if (p === '/lists' && o.method === 'POST') { const l = { id: `l-${++n}`, name: body.name }; lists.push(l); return json(200, l); }
    if (p === '/labels' && o.method === 'POST') { const l = { id: `lab-${++n}`, name: body.name, color: body.color }; labels.push(l); return json(200, l); }
    if (p === '/cards' && o.method === 'POST') return json(200, add({ name: body.name, desc: body.desc, idList: body.idList, due: body.due, idLabels: csv(body.idLabels), idMembers: csv(body.idMembers) }));
    const m = p.match(/^\/cards\/(.+)$/);
    if (m && o.method === 'PUT') { const c = cards.get(m[1]); for (const [k, v] of Object.entries(body)) c[k] = (k === 'idLabels' || k === 'idMembers') ? csv(v) : v; c.dateLastActivity = now(); return json(200, c); }
    return json(404, `no route ${o.method} ${p}`);
  };
  return {
    fetch, cfg: { settings: { boardId: 'https://trello.com/b/AbCd12/my-board' }, secrets: { apiKey: 'k', token: 't' } },
    remoteSetStatus: (title, s) => { const c = [...cards.values()].find(x => x.name === title); c.idList = lists.find(l => l.name === s)?.id || (s === 'In Progress' ? 'l2' : 'l1'); c.dateLastActivity = now(); },
    remoteTitle: (id) => cards.get(id)?.name,
    remoteDelete: (title) => { const c = [...cards.values()].find(x => x.name === title); cards.delete(c.id); },
    count: () => cards.size,
  };
}


// One fetch that routes to whichever fake owns the host.
function combinedFetch() {
  const f = { jira: fakeJira(), notion: fakeNotion(), trello: fakeTrello() };
  return (url, o) => (url.includes('atlassian') ? f.jira : url.includes('notion') ? f.notion : f.trello).fetch(url, o);
}
module.exports = { fakeJira, fakeNotion, fakeTrello, combinedFetch };
