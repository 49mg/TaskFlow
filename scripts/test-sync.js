// Tests the sync engine + Jira/Notion/Trello connectors against in-memory fakes of each API.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.TASKFLOW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taskflow-sync-'));
const { api, read } = require('../src/store');
const { createManager } = require('../src/integrations');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} - ${m}`); if (!c) failures++; };

const { fakeJira, fakeNotion, fakeTrello } = require('./fake-services');

(async () => {
  for (const [provider, make] of [['jira', fakeJira], ['notion', fakeNotion], ['trello', fakeTrello]]) {
    console.log(`\n# ${provider}`);
    const fake = make();
    const mgr = createManager({ fetchImpl: fake.fetch });
    const proj = api.createProject({ key: provider.toUpperCase().slice(0, 4) + 'X', name: `${provider} test` });
    api.createIssue({ project: proj.id, title: 'Local A', type: 'bug', priority: 'high', labels: ['ui', 'needs review'], assignee: 'Alex', dueDate: '2026-12-01', description: 'Line one\n- item' });
    api.createIssue({ project: proj.id, title: 'Local B', status: 'in_progress', storyPoints: 3 });

    ok(/Connected/.test(await mgr.test(proj.id, provider, fake.cfg)), 'test connection');
    let bad = null; try { await mgr.test(proj.id, provider, { ...fake.cfg, secrets: Object.fromEntries(Object.keys(fake.cfg.secrets).map(k => [k, 'wrong'])) }); } catch (e) { bad = e.message; }
    ok(bad && /401|auth/i.test(bad), `bad credentials rejected (${bad?.slice(0, 50)})`);
    mgr.save(proj.id, provider, { ...fake.cfg, direction: 'two-way' });
    ok(!JSON.stringify(mgr.list(proj.id)).includes(Object.values(fake.cfg.secrets)[0] + '"'), 'secrets not exposed to UI');

    let r = await mgr.sync(proj.id, provider);
    ok(r.exported === 2 && r.imported === 1 && !r.errors.length, `first sync: exported ${r.exported}, imported ${r.imported}, errors ${JSON.stringify(r.errors)}`);
    const issues = () => read().issues.filter(i => i.projectId === proj.id);
    const imported = issues().find(i => /^Remote/.test(i.title));
    ok(imported && imported.links[provider].url, `imported "${imported?.title}" (${imported?.type}/${imported?.status}) with link`);
    if (provider === 'jira') ok(imported.type === 'bug' && imported.priority === 'high' && imported.description === 'From Jira', 'jira fields mapped (type, priority, ADF description)');
    if (provider !== 'jira') ok(imported.status === 'in_progress', 'remote status mapped to In Progress');

    r = await mgr.sync(proj.id, provider);
    ok(r.pushed === 0 && r.pulled === 0 && r.imported === 0 && r.exported === 0, `second sync is a no-op (pushed ${r.pushed}, pulled ${r.pulled}) ${r.warnings.join(' | ')}`);

    fake.remoteSetStatus('Local A', 'Done');
    const b = issues().find(i => i.title === 'Local B');
    api.updateIssue(b.id, { title: 'Local B renamed' });
    r = await mgr.sync(proj.id, provider);
    ok(issues().find(i => i.title === 'Local A').status === 'done', 'remote status change pulled into TaskFlow');
    ok(fake.remoteTitle(issues().find(i => i.title === 'Local B renamed').links[provider].id) === 'Local B renamed', 'local title change pushed to remote');

    r = await mgr.sync(proj.id, provider);
    ok(r.pushed === 0 && r.pulled === 0, 'stable after changes');

    fake.remoteDelete('Remote ' + { jira: 'Jira issue', notion: 'Notion page', trello: 'Trello card' }[provider]);
    r = await mgr.sync(proj.id, provider);
    ok(r.unlinked === 1 && issues().some(i => /^Remote/.test(i.title)), 'remote delete unlinks but keeps TaskFlow issue');

    const before = fake.count();
    api.deleteIssue(issues().find(i => i.title === 'Local A').id);
    r = await mgr.sync(proj.id, provider);
    ok(r.imported === 0 && fake.count() === before, 'locally deleted issue is not re-imported');

    mgr.remove(proj.id, provider);
    ok(!issues().some(i => i.links?.[provider]) && !mgr.list(proj.id)[provider].connected, 'disconnect removes credentials and links');
  }
  fs.rmSync(process.env.TASKFLOW_DATA_DIR, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nAll sync tests passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
