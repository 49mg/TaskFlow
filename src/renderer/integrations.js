/* Integrations page (Jira / Notion / Trello). Uses helpers from app.js ($, esc, S, toast, …). */
'use strict';

const INT = {
  jira: {
    name: 'Jira', letter: 'J', color: '#1868DB', target: 'a Jira project',
    blurb: 'Columns map to Jira statuses (via workflow transitions). Type, priority, labels, assignee and due date map to Jira fields.',
    fields: [
      ['site', 'Jira site', 'your-team.atlassian.net', 'text'],
      ['email', 'Account email', 'you@company.com', 'email'],
      ['projectKey', 'Project key', 'PROJ', 'text'],
      ['token', 'API token', '', 'password'],
    ],
    help: [
      'Create an API token at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank">id.atlassian.com → Security → API tokens</a>.',
      'Your site is the address you open Jira at, e.g. <code>your-team.atlassian.net</code>.',
      'The project key is the prefix of issue keys — <code>PROJ</code> in <code>PROJ-12</code>.',
    ],
    summary: (s) => `${esc(s.projectKey)} on ${esc(String(s.site).replace(/^https?:\/\//, ''))}`,
  },
  notion: {
    name: 'Notion', letter: 'N', color: '#191919', target: 'a Notion database',
    blurb: 'Each issue becomes a database page. Status, Type, Priority, Assignee, Labels, Story Points, Due and Description properties are added if missing.',
    fields: [
      ['databaseId', 'Database link or ID', 'https://www.notion.so/…', 'text'],
      ['token', 'Integration secret', '', 'password'],
    ],
    help: [
      'Create an internal integration at <a href="https://www.notion.so/profile/integrations" target="_blank">notion.so/profile/integrations</a> and copy its secret.',
      'Open your database in Notion → <b>•••</b> menu → <b>Connections</b> → add your integration.',
      'Copy the database link (<b>Share → Copy link</b>) and paste it here.',
    ],
    summary: (s) => `Database ${esc(String(s.databaseId).replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0]?.slice(0, 8) || '')}…`,
  },
  trello: {
    name: 'Trello', letter: 'T', color: '#0C66E4', target: 'a Trello board',
    blurb: 'Columns map to lists (To Do, In Progress, In Review, Done — created if missing). Type and priority become labels like type:bug.',
    fields: [
      ['boardId', 'Board link or ID', 'https://trello.com/b/AbC123/my-board', 'text'],
      ['apiKey', 'API key', '', 'password'],
      ['token', 'Token', '', 'password'],
    ],
    help: [
      'Go to <a href="https://trello.com/power-ups/admin" target="_blank">trello.com/power-ups/admin</a>, create a Power-Up for your workspace, then open <b>API key</b> → generate a key.',
      'Next to the key, click the <b>Token</b> link, allow access and copy the token.',
      'Paste your board link, e.g. <code>trello.com/b/AbC123/my-board</code>.',
    ],
    summary: (s) => `Board ${esc(String(s.boardId).match(/trello\.com\/b\/([^/?#]+)/)?.[1] || s.boardId)}`,
  },
};
const DIRECTIONS = { 'two-way': 'Two-way sync', push: 'TaskFlow → {name} only', pull: '{name} → TaskFlow only' };
const AUTO = { 0: 'Manual only', 5: 'Every 5 minutes', 15: 'Every 15 minutes', 60: 'Every hour' };

const IS = { list: null, meta: null, editing: new Set(), busy: new Set(), lastLoadedFor: null, details: new Set() };

async function loadIntegrations() {
  const pid = S.projectId;
  if (!IS.meta) IS.meta = await window.taskflow.integrations('providers');
  IS.list = await window.taskflow.integrations('list', pid);
  IS.lastLoadedFor = pid;
}
window.taskflow.onIntegrationsChanged(async () => { if (S.view === 'integrations') { await loadIntegrations(); render(); } });

function resultLine(st) {
  if (!st) return '<span class="muted">Never synced</span>';
  const r = st.lastResult;
  const parts = [];
  if (st.lastError && (!st.lastSync || st.lastErrorAt > st.lastSync)) return `<span class="int-err">Last sync failed ${timeAgo(st.lastErrorAt)}: ${esc(st.lastError)}</span>`;
  if (r) {
    if (r.imported) parts.push(`${r.imported} imported`);
    if (r.exported) parts.push(`${r.exported} exported`);
    if (r.pulled) parts.push(`${r.pulled} updated here`);
    if (r.pushed) parts.push(`${r.pushed} updated there`);
    if (r.unlinked) parts.push(`${r.unlinked} unlinked`);
  }
  return `Synced ${timeAgo(st.lastSync)} · ${parts.length ? parts.join(' · ') : 'everything up to date'}`;
}

function intCard(key) {
  const d = INT[key], c = IS.list[key];
  const editing = !c.connected || IS.editing.has(key);
  const busy = c.running || IS.busy.has(key);
  const st = c.state;
  const r = st?.lastResult;
  const issuesN = (r?.errors?.length || 0) + (r?.warnings?.length || 0);
  const status = busy ? '<span class="int-pill busy"><span class="spin"></span>Syncing…</span>'
    : !c.connected ? '<span class="int-pill">Not connected</span>'
    : st?.lastError && (!st.lastSync || st.lastErrorAt > st.lastSync) ? '<span class="int-pill error">Error</span>'
    : '<span class="int-pill on">Connected</span>';
  const name = d.name;
  return `<section class="int-card ${c.connected ? 'connected' : ''}" data-int="${key}">
    <div class="int-head">
      <div class="int-logo" style="background:${d.color}">${d.letter}</div>
      <div style="flex:1"><div class="int-name">${name}</div><div class="muted int-target">${c.connected ? d.summary(c.settings) : `Sync with ${d.target}`}</div></div>
      ${status}
    </div>
    <p class="int-blurb">${d.blurb}</p>
    ${editing ? `
      <div class="int-form">
        ${d.fields.map(([k, label, ph, type]) => {
          const isSecret = type === 'password';
          const val = isSecret ? '' : (c.settings?.[k] || '');
          const placeholder = isSecret && c.secretsSet?.[k] ? '•••••••• saved — leave blank to keep' : ph;
          return `<div class="field"><label>${label}</label><input class="input" data-f="${k}" data-secret="${isSecret ? 1 : ''}" type="${type}" value="${esc(val)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" /></div>`;
        }).join('')}
        <div class="row">
          <div class="field"><label>Direction</label><select class="select" data-f="direction">${Object.entries(DIRECTIONS).map(([v, l]) => opt(v, l.replace('{name}', name), (c.direction || 'two-way') === v)).join('')}</select></div>
          <div class="field"><label>Auto-sync</label><select class="select" data-f="autoSync">${Object.entries(AUTO).map(([v, l]) => opt(v, l, String(c.autoSync || 0) === v)).join('')}</select></div>
        </div>
        <details class="int-help"><summary>Where do I find these?</summary><ol>${d.help.map(h => `<li>${h}</li>`).join('')}</ol></details>
        <div class="int-test-result" data-test-result></div>
        <div class="int-actions">
          <button class="btn" data-act="test" ${busy ? 'disabled' : ''}>Test connection</button>
          <span class="spacer"></span>
          ${c.connected ? '<button class="btn btn-subtle" data-act="cancel">Cancel</button>' : ''}
          <button class="btn btn-primary" data-act="save" ${busy ? 'disabled' : ''}>${c.connected ? 'Save' : 'Connect & sync'}</button>
        </div>
      </div>` : `
      <div class="int-meta">
        <div><span class="muted">Direction</span>${esc(DIRECTIONS[c.direction || 'two-way'].replace('{name}', name))}</div>
        <div><span class="muted">Auto-sync</span>${esc(AUTO[c.autoSync || 0])}</div>
      </div>
      <div class="int-result">${resultLine(st)}</div>
      ${issuesN ? `<details class="int-issues" ${IS.details.has(key) ? 'open' : ''} data-details="${key}"><summary>${r.errors.length ? `${r.errors.length} error${r.errors.length > 1 ? 's' : ''}` : ''}${r.errors.length && r.warnings.length ? ', ' : ''}${r.warnings.length ? `${r.warnings.length} note${r.warnings.length > 1 ? 's' : ''}` : ''} from the last sync</summary>
        <ul>${r.errors.map(e => `<li class="int-err">${esc(e)}</li>`).join('')}${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      <div class="int-actions">
        <button class="btn btn-primary" data-act="sync" ${busy ? 'disabled' : ''}>${busy ? 'Syncing…' : 'Sync now'}</button>
        <button class="btn" data-act="edit" ${busy ? 'disabled' : ''}>Edit</button>
        <span class="spacer"></span>
        <button class="btn btn-subtle int-disconnect" data-act="remove" ${busy ? 'disabled' : ''}>Disconnect</button>
      </div>`}
  </section>`;
}

function viewIntegrations(root) {
  if (IS.lastLoadedFor !== S.projectId || !IS.list) {
    root.innerHTML = `${pageHeader('Integrations')}<div class="muted">Loading…</div>`;
    bindHeader(root);
    loadIntegrations().then(render).catch(e => toast(e.message, true));
    return;
  }
  const p = project();
  const linked = projectIssues().filter(i => Object.values(i.links || {}).some(l => !l.removed)).length;
  root.innerHTML = `${pageHeader('Integrations')}
    <div class="page-sub">Optional. Keep <b>${esc(p.name)}</b> in sync with Jira, Notion or Trello using the same issues, columns and fields you use here.${linked ? ` <span class="muted">${linked} issue${linked > 1 ? 's' : ''} linked.</span>` : ''}</div>
    ${IS.meta.encrypted ? '' : `<div class="int-banner">Your system keyring isn't available, so credentials are saved unencrypted in <code>~/.taskflow/integrations.json</code> (readable only by your user account).</div>`}
    <div class="int-grid">${Object.keys(INT).map(intCard).join('')}</div>
    <div class="int-footnote">
      <b>What syncs:</b> title, description, status (column), type, priority, labels, assignee and due date — plus story points with Notion.
      <b>Not synced:</b> comments, sprints and epic links. Deleting an item on one side unlinks it on the other instead of deleting it.
    </div>`;
  bindHeader(root);

  $$('.int-card', root).forEach(cardEl => {
    const key = cardEl.dataset.int;
    const name = INT[key].name;
    const draft = () => {
      const settings = {}, secrets = {};
      $$('[data-f]', cardEl).forEach(el => {
        if (el.dataset.f === 'direction' || el.dataset.f === 'autoSync') return;
        (el.dataset.secret ? secrets : settings)[el.dataset.f] = el.value.trim();
      });
      return { settings, secrets, direction: $('[data-f=direction]', cardEl)?.value, autoSync: Number($('[data-f=autoSync]', cardEl)?.value || 0) };
    };
    const setBusy = (on) => { on ? IS.busy.add(key) : IS.busy.delete(key); };
    const showTest = (ok, msg) => { const el = $('[data-test-result]', cardEl); if (el) el.innerHTML = `<div class="int-test ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${esc(msg)}</div>`; };
    const runSync = async () => {
      setBusy(true); render();
      try {
        const r = await window.taskflow.integrations('sync', S.projectId, key);
        const total = r.imported + r.exported + r.pulled + r.pushed;
        toast(r.errors.length ? `${name} sync finished with ${r.errors.length} error(s)` : total ? `${name} synced: ${total} change${total > 1 ? 's' : ''}` : `${name} is up to date`, !!r.errors.length);
      } catch (e) { toast(`${name}: ${e.message}`, true); }
      setBusy(false); await loadIntegrations(); await load();
    };
    $$('[data-act]', cardEl).forEach(b => b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'test') {
        b.disabled = true; b.textContent = 'Testing…';
        try { showTest(true, await window.taskflow.integrations('test', S.projectId, key, draft())); }
        catch (e) { showTest(false, e.message); }
        b.disabled = false; b.textContent = 'Test connection';
      }
      if (act === 'save') {
        const wasConnected = IS.list[key].connected;
        b.disabled = true; b.textContent = 'Checking…';
        try {
          const d = draft();
          await window.taskflow.integrations('test', S.projectId, key, d); // verify before saving
          await window.taskflow.integrations('save', S.projectId, key, d);
          IS.editing.delete(key);
          await loadIntegrations();
          toast(`${name} ${wasConnected ? 'settings saved' : 'connected'}`);
          if (!wasConnected) await runSync(); else render();
        } catch (e) { showTest(false, e.message); b.disabled = false; b.textContent = wasConnected ? 'Save' : 'Connect & sync'; }
      }
      if (act === 'cancel') { IS.editing.delete(key); render(); }
      if (act === 'edit') { IS.editing.add(key); render(); }
      if (act === 'sync') await runSync();
      if (act === 'remove') {
        const n = projectIssues().filter(i => i.links?.[key]).length;
        if (await confirmModal(`Disconnect ${name}?`, `TaskFlow will forget your ${name} credentials and unlink ${n} issue(s). Nothing is deleted in TaskFlow or in ${name}.`, 'Disconnect', true)) {
          await window.taskflow.integrations('remove', S.projectId, key);
          await loadIntegrations(); await load(); toast(`${name} disconnected`);
        }
      }
    });
    $('[data-details]', cardEl)?.addEventListener('toggle', (e) => { e.target.open ? IS.details.add(key) : IS.details.delete(key); });
  });
}

// Small "J / N / T" link badges for cards, rows and the issue detail.
function linkBadges(i) {
  const links = Object.entries(i.links || {}).filter(([k, l]) => INT[k] && !l.removed);
  return links.map(([k]) => `<span class="link-badge" style="background:${INT[k].color}" title="Synced with ${INT[k].name}">${INT[k].letter}</span>`).join('');
}
function linkedPanel(i) {
  const links = Object.entries(i.links || {}).filter(([k]) => INT[k]);
  if (!links.length) return '';
  return `<div class="details-box"><div class="dh">Linked</div><div class="linked-list">${links.map(([k, l]) => `
    <div class="linked-row"><span class="link-badge" style="background:${INT[k].color}">${INT[k].letter}</span>
      <span style="flex:1">${INT[k].name}${l.removed ? ' <span class="muted">· deleted there, no longer synced</span>' : ''}</span>
      ${l.url && !l.removed ? `<a href="${esc(l.url)}" target="_blank">Open ↗</a>` : ''}</div>`).join('')}</div></div>`;
}
