// Generic two-way sync between a TaskFlow project and one external service.
//
// Every linked issue stores `links[provider] = { id, url, base }`, where `base` is the field values
// both sides agreed on at the last sync. That gives a field-level three-way merge:
//   only TaskFlow changed a field -> push it;  only the remote changed -> pull it;
//   both changed -> the side edited most recently wins.
'use strict';

const { read, mutateData } = require('../store');
const { normalize, eq } = require('./util');

const LOCAL_FIELDS = ['title', 'description', 'status', 'type', 'priority', 'labels', 'assignee', 'dueDate', 'storyPoints'];
const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

/**
 * @param {object} o
 * @param {string} o.projectId
 * @param {string} o.provider   'jira' | 'notion' | 'trello'
 * @param {object} o.adapter    { init(), list(), create(fields), update(extId, fields, changedKeys, remoteItem), fields[], normalize?() }
 * @param {'two-way'|'push'|'pull'} [o.direction]
 */
async function syncProject({ projectId, provider, adapter, direction = 'two-way' }) {
  const started = Date.now();
  const stats = { imported: 0, exported: 0, pulled: 0, pushed: 0, unlinked: 0, errors: [], warnings: [] };
  const canPush = direction !== 'pull';
  const canPull = direction !== 'push';

  await adapter.init();
  const F = adapter.fields;
  const norm = (f) => { const n = normalize(pick(f, F)); return adapter.normalize ? adapter.normalize(n) : n; };

  const snapshot = read();
  if (!snapshot.projects.find(p => p.id === projectId)) throw new Error('Project not found');
  const state = snapshot.syncState?.[projectId]?.[provider] || {};
  const known = new Set(state.knownRemote || []);
  const remote = await adapter.list();
  const remoteById = new Map(remote.map(r => [r.extId, r]));
  const issues = snapshot.issues.filter(i => i.projectId === projectId);

  const localOps = [];   // { id, updatedAt, patch?, link }
  const newLocal = [];   // { fields, link }
  const linkedRemote = new Set();

  for (const issue of issues) {
    const link = issue.links?.[provider];
    if (!link || link.removed) continue;
    const r = remoteById.get(link.id);
    linkedRemote.add(link.id);
    if (!r) { // deleted (or filtered out) on the remote side: keep the TaskFlow issue, stop syncing it
      localOps.push({ id: issue.id, updatedAt: issue.updatedAt, link: { id: link.id, removed: true } });
      stats.unlinked++;
      continue;
    }
    try {
      const L = norm(issue), R = norm(r.fields), B = link.base ? norm(link.base) : {};
      const merged = {};
      for (const k of F) {
        if (direction === 'push') merged[k] = L[k];
        else if (direction === 'pull') merged[k] = R[k];
        else if (eq(L[k], R[k])) merged[k] = L[k];
        else if (eq(L[k], B[k])) merged[k] = R[k];       // only remote changed
        else if (eq(R[k], B[k])) merged[k] = L[k];       // only local changed
        else merged[k] = new Date(issue.updatedAt) >= new Date(r.updatedAt) ? L[k] : R[k]; // conflict: newest wins
      }
      const remoteChanged = F.filter(k => !eq(merged[k], R[k]));
      const localChanged = F.filter(k => !eq(merged[k], L[k]));
      let url = r.url;
      if (remoteChanged.length && canPush) {
        const res = await adapter.update(r.extId, merged, remoteChanged, r);
        if (res?.warning) stats.warnings.push(`${issue.key}: ${res.warning}`);
        url = res?.url || url;
        stats.pushed++;
      }
      const op = { id: issue.id, updatedAt: issue.updatedAt, link: { id: r.extId, url, base: merged, syncedAt: new Date().toISOString() } };
      if (localChanged.length && canPull) { op.patch = pick(merged, localChanged); stats.pulled++; }
      localOps.push(op);
    } catch (e) { stats.errors.push(`${issue.key}: ${e.message}`); }
  }

  // Remote items with no TaskFlow issue yet -> import (unless we deleted it locally after a previous sync).
  if (canPull) {
    for (const r of remote) {
      if (linkedRemote.has(r.extId) || known.has(r.extId)) continue;
      newLocal.push({ fields: norm(r.fields), link: { id: r.extId, url: r.url, base: norm(r.fields), syncedAt: new Date().toISOString() } });
      stats.imported++;
    }
  }

  // TaskFlow issues never synced -> create them remotely.
  if (canPush) {
    for (const issue of issues) {
      if (issue.links?.[provider]) continue;
      try {
        const L = norm(issue);
        const res = await adapter.create(L, issue);
        if (res?.warning) stats.warnings.push(`${issue.key}: ${res.warning}`);
        localOps.push({ id: issue.id, updatedAt: issue.updatedAt, link: { id: res.extId, url: res.url, base: L, syncedAt: new Date().toISOString() } });
        linkedRemote.add(res.extId);
        stats.exported++;
      } catch (e) { stats.errors.push(`${issue.key}: ${e.message}`); }
    }
  }

  // Apply everything locally in one locked write.
  mutateData(data => {
    const project = data.projects.find(p => p.id === projectId);
    for (const op of localOps) {
      const i = data.issues.find(x => x.id === op.id);
      if (!i) continue;
      i.links = { ...(i.links || {}), [provider]: op.link };
      // If the user edited the issue while we were syncing, keep their edit; next sync reconciles it.
      if (op.patch && i.updatedAt === op.updatedAt) {
        Object.assign(i, op.patch);
        if (op.patch.assignee && !data.users.includes(op.patch.assignee)) data.users.push(op.patch.assignee);
        i.updatedAt = new Date().toISOString();
      }
    }
    const t = new Date().toISOString();
    for (const n of newLocal) {
      project.issueCounter += 1;
      const f = { ...pick(Object.fromEntries(LOCAL_FIELDS.map(k => [k, null])), LOCAL_FIELDS), ...n.fields };
      if (f.assignee && !data.users.includes(f.assignee)) data.users.push(f.assignee);
      data.issues.push({
        id: require('crypto').randomUUID(), key: `${project.key}-${project.issueCounter}`, projectId,
        type: f.type || 'task', title: f.title || '(untitled)', description: f.description || '', status: f.status || 'todo',
        priority: f.priority || 'medium', assignee: f.assignee || null, reporter: provider === 'jira' ? 'Jira' : provider === 'notion' ? 'Notion' : 'Trello',
        labels: f.labels || [], storyPoints: f.storyPoints ?? null, epicId: null, sprintId: null, dueDate: f.dueDate || null,
        createdAt: t, updatedAt: t, order: Math.max(0, ...data.issues.map(i => i.order || 0)) + 1,
        links: { [provider]: n.link },
      });
    }
    data.syncState = data.syncState || {};
    data.syncState[projectId] = data.syncState[projectId] || {};
    const allLinked = new Set(data.issues.filter(i => i.projectId === projectId && i.links?.[provider]?.id && !i.links[provider].removed).map(i => i.links[provider].id));
    data.syncState[projectId][provider] = {
      lastSync: t, durationMs: Date.now() - started,
      knownRemote: [...new Set([...allLinked, ...[...known].filter(id => remoteById.has(id))])],
      lastResult: { ...stats, errors: stats.errors.slice(0, 50), warnings: stats.warnings.slice(0, 50) },
    };
  });
  return stats;
}

module.exports = { syncProject, LOCAL_FIELDS };
