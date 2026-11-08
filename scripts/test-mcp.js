// End-to-end test: spawns the MCP server over stdio with a temp data dir and exercises the tools.
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-test-'));
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('ok -', msg); };

(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', 'mcp', 'server.js')],
    env: { ...process.env, TASKFLOW_DATA_DIR: dir },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  const callTool = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) return { error: text };
    try { return JSON.parse(text); } catch { return text; }
  };

  const { tools } = await client.listTools();
  assert(tools.length >= 21, `lists ${tools.length} tools`);

  const projects = await callTool('list_projects');
  assert(projects[0].key === 'DEMO', 'seeded DEMO project');

  const created = await callTool('create_issue', { project: 'DEMO', title: 'From MCP', type: 'bug', priority: 'high', assignee: 'Sam', labels: ['mcp'] });
  assert(created.key === 'DEMO-8' && created.reporter === 'Claude', `created ${created.key}`);

  const moved = await callTool('transition_issue', { key: 'DEMO-8', status: 'in_progress' });
  assert(/In Progress/.test(moved), 'transition works');

  const upd = await callTool('update_issue', { key: 'demo-8', storyPoints: 3, epic: 'DEMO-1', sprint: 'DEMO Sprint 1' });
  assert(upd.storyPoints === 3 && upd.epic === 'DEMO-1' && upd.sprint === 'DEMO Sprint 1', 'update with epic/sprint refs');

  await callTool('add_comment', { key: 'DEMO-8', body: 'Looking into it' });
  const full = await callTool('get_issue', { key: 'DEMO-8' });
  assert(full.comments.length === 1 && full.comments[0].author === 'Claude', 'comment added');

  const list = await callTool('list_issues', { project: 'DEMO', assignee: 'Sam' });
  assert(list.total === 2, `filter by assignee (${list.total})`);

  const board = await callTool('get_board', { project: 'DEMO' });
  assert(board.columns['In Progress'].some(s => s.startsWith('DEMO-8')), 'board shows issue in column');

  const sp = await callTool('create_sprint', { project: 'DEMO', goal: 'Next' });
  const err = await callTool('start_sprint', { sprint: sp.name });
  assert(err.error && /active sprint/.test(err.error), 'cannot start 2nd sprint while one active');
  const done = await callTool('complete_sprint', { sprint: 'DEMO Sprint 1' });
  assert(done.incompleteMovedToBacklog === 4, `complete sprint moves incomplete (${done.incompleteMovedToBacklog})`);
  await callTool('start_sprint', { sprint: sp.name });
  await callTool('move_to_sprint', { keys: ['DEMO-8', 'DEMO-7'], sprint: sp.name });
  const sprints = await callTool('list_sprints', { project: 'DEMO' });
  assert(sprints.find(s => s.name === sp.name).issues === 2, 'move_to_sprint');

  const np = await callTool('create_project', { key: 'WEB', name: 'Website' });
  const wi = await callTool('create_issue', { project: 'Website', title: 'Hero section' });
  assert(np.key === 'WEB' && wi.key === 'WEB-1', 'new project + issue key numbering');

  const bad = await callTool('get_issue', { key: 'NOPE-1' });
  assert(bad.error, 'unknown issue returns error');

  const del = await callTool('delete_issue', { key: 'WEB-1' });
  assert(del.deleted === 'WEB-1', 'delete issue');

  const pdf = path.join(dir, 'Spec_Sheet.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n%%EOF\n');
  const doc = await callTool('add_document', { project: 'DEMO', path: pdf, name: 'Requirements' });
  assert(doc.name === 'Requirements' && doc.uploadedBy === 'Claude' && fs.existsSync(doc.path), 'add_document copies the PDF');
  const notPdf = path.join(dir, 'notes.txt'); fs.writeFileSync(notPdf, 'hello');
  assert((await callTool('add_document', { project: 'DEMO', path: notPdf })).error, 'add_document rejects non-PDF');
  const docs = await callTool('list_documents', { project: 'DEMO' });
  assert(docs.length === 1 && docs[0].name === 'Requirements', 'list_documents');

  await client.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nAll MCP tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
