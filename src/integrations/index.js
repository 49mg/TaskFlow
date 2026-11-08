// Integration manager: stores connection settings (secrets encrypted with the OS keychain via
// Electron safeStorage when available), runs syncs, and schedules auto-sync.
'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR, read, mutateData } = require('../store');
const { syncProject } = require('./engine');
const { JiraAdapter } = require('./jira');
const { NotionAdapter } = require('./notion');
const { TrelloAdapter } = require('./trello');

const FILE = path.join(DATA_DIR, 'integrations.json');

// settings = non-secret fields, secrets = credentials (never sent to the renderer).
const PROVIDERS = {
  jira: { name: 'Jira', settings: ['site', 'email', 'projectKey'], secrets: ['token'], make: (c, f) => new JiraAdapter(c, f) },
  notion: { name: 'Notion', settings: ['databaseId'], secrets: ['token'], make: (c, f) => new NotionAdapter(c, f) },
  trello: { name: 'Trello', settings: ['boardId'], secrets: ['apiKey', 'token'], make: (c, f) => new TrelloAdapter(c, f) },
};

function createManager({ safeStorage, onChange = () => {}, fetchImpl } = {}) {
  const canEncrypt = () => { try { return !!safeStorage?.isEncryptionAvailable(); } catch { return false; } };
  const enc = (v) => canEncrypt() ? 'enc:' + safeStorage.encryptString(v).toString('base64') : 'plain:' + v;
  const dec = (v) => {
    if (!v) return '';
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    return v.replace(/^plain:/, '');
  };
  const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { projects: {} }; } };
  const save = (cfg) => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2), { mode: 0o600 });
    fs.renameSync(FILE + '.tmp', FILE);
  };
  const running = new Set();

  function credentials(projectId, provider, draft) {
    const saved = load().projects[projectId]?.[provider];
    const p = PROVIDERS[provider];
    const c = {};
    for (const k of p.settings) c[k] = draft?.settings?.[k] ?? saved?.settings?.[k];
    for (const k of p.secrets) c[k] = draft?.secrets?.[k] || dec(saved?.secrets?.[k]);
    return c;
  }
  const adapterFor = (projectId, provider, draft) => PROVIDERS[provider].make(credentials(projectId, provider, draft), fetchImpl || fetch);

  const api = {
    providers: () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { name: v.name, settings: v.settings, secrets: v.secrets }])),
    encryptionAvailable: canEncrypt,

    // Safe view for the UI: settings + which secrets are set, never the secret values.
    list(projectId) {
      const cfg = load().projects[projectId] || {};
      const state = read().syncState?.[projectId] || {};
      return Object.fromEntries(Object.keys(PROVIDERS).map(k => {
        const c = cfg[k];
        return [k, c ? {
          connected: true, direction: c.direction, autoSync: c.autoSync, settings: c.settings,
          secretsSet: Object.fromEntries(PROVIDERS[k].secrets.map(s => [s, !!c.secrets?.[s]])),
          running: running.has(`${projectId}:${k}`), state: state[k] || null,
        } : { connected: false, running: false, state: null }];
      }));
    },

    save(projectId, provider, { settings = {}, secrets = {}, direction = 'two-way', autoSync = 0 }) {
      if (!PROVIDERS[provider]) throw new Error(`Unknown provider ${provider}`);
      const cfg = load();
      cfg.projects[projectId] = cfg.projects[projectId] || {};
      const prev = cfg.projects[projectId][provider] || {};
      const p = PROVIDERS[provider];
      const next = { direction, autoSync: Number(autoSync) || 0, settings: {}, secrets: { ...(prev.secrets || {}) } };
      for (const k of p.settings) next.settings[k] = String(settings[k] ?? prev.settings?.[k] ?? '').trim();
      for (const k of p.secrets) if (secrets[k]) next.secrets[k] = enc(String(secrets[k]).trim());
      const missing = [...p.settings.filter(k => !next.settings[k]), ...p.secrets.filter(k => !next.secrets[k])];
      if (missing.length) throw new Error(`Missing: ${missing.join(', ')}`);
      cfg.projects[projectId][provider] = next;
      save(cfg);
      return api.list(projectId)[provider];
    },

    async test(projectId, provider, draft) {
      return adapterFor(projectId, provider, draft).test();
    },

    // Disconnect: forget credentials and unlink issues (the issues themselves are kept).
    remove(projectId, provider) {
      const cfg = load();
      if (cfg.projects[projectId]) { delete cfg.projects[projectId][provider]; save(cfg); }
      mutateData(data => {
        data.issues.forEach(i => { if (i.projectId === projectId && i.links?.[provider]) delete i.links[provider]; });
        if (data.syncState?.[projectId]) delete data.syncState[projectId][provider];
      });
      return true;
    },

    async sync(projectId, provider) {
      const cfg = load().projects[projectId]?.[provider];
      if (!cfg) throw new Error(`${PROVIDERS[provider].name} is not connected for this project`);
      const key = `${projectId}:${provider}`;
      if (running.has(key)) throw new Error('A sync is already running');
      running.add(key); onChange();
      try {
        return await syncProject({ projectId, provider, adapter: adapterFor(projectId, provider), direction: cfg.direction });
      } catch (e) {
        mutateData(data => {
          data.syncState = data.syncState || {};
          data.syncState[projectId] = data.syncState[projectId] || {};
          data.syncState[projectId][provider] = { ...(data.syncState[projectId][provider] || {}), lastError: e.message, lastErrorAt: new Date().toISOString() };
        });
        throw e;
      } finally { running.delete(key); onChange(); }
    },

    // Called every minute; runs any connection whose auto-sync interval has elapsed.
    async tick() {
      const cfg = load();
      const state = read().syncState || {};
      for (const [projectId, provs] of Object.entries(cfg.projects)) {
        if (!read().projects.some(p => p.id === projectId)) continue;
        for (const [provider, c] of Object.entries(provs)) {
          if (!c.autoSync) continue;
          const s = state[projectId]?.[provider];
          const last = Math.max(new Date(s?.lastSync || 0).getTime(), new Date(s?.lastErrorAt || 0).getTime());
          if (Date.now() - last >= c.autoSync * 60000) await api.sync(projectId, provider).catch(() => {});
        }
      }
    },
  };
  return api;
}

module.exports = { createManager, PROVIDERS };
