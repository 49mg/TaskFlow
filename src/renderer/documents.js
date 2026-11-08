/* Project documents (PDF upload + naming). Uses helpers from app.js ($, esc, S, toast, …). */
'use strict';

const DOCS = { q: '' };
const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const defaultDocName = (fileName) => fileName.replace(/\.pdf$/i, '').replace(/_+/g, ' ').trim();
const projectDocs = () => (S.data.documents || []).filter(d => d.projectId === S.projectId);
const PDF_ICON = '<svg viewBox="0 0 40 48" class="pdf-icon"><path d="M4 0h22l14 14v30a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z" fill="#E5493A"/><path d="M26 0v10a4 4 0 0 0 4 4h10Z" fill="#fff" opacity=".45"/><text x="20" y="36" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="Inter Variable, sans-serif">PDF</text></svg>';

// Dropping a file anywhere in an Electron window would otherwise open it in place of the app.
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

function viewDocuments(root) {
  const all = projectDocs().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const q = DOCS.q.toLowerCase();
  const list = all.filter(d => !q || `${d.name} ${d.fileName}`.toLowerCase().includes(q));
  const total = all.reduce((n, d) => n + d.size, 0);
  root.innerHTML = `${pageHeader('Documents', `<button class="btn btn-primary" id="docUpload"><svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M11 16V7.8l-2.6 2.6L7 9l5-5 5 5-1.4 1.4L13 7.8V16h-2Zm-5 4a2 2 0 0 1-2-2v-3h2v3h12v-3h2v3a2 2 0 0 1-2 2H6Z"/></svg>Upload PDF</button>`)}
    <div class="page-sub">PDFs for this project${all.length ? ` · ${all.length} document${all.length > 1 ? 's' : ''} · ${fmtSize(total)}` : ''}. Drag files anywhere on this page to upload.</div>
    ${all.length ? `
      <div class="toolbar"><input class="input" id="docQ" placeholder="Search documents" value="${esc(DOCS.q)}" /></div>
      <div class="doc-grid">${list.map(d => `
        <div class="doc-card" data-doc="${d.id}" title="Open ${esc(d.name)}">
          <div class="doc-thumb">${PDF_ICON}</div>
          <div class="doc-body">
            <div class="doc-name">${esc(d.name)}</div>
            <div class="doc-meta" title="${esc(d.fileName)}">${esc(d.fileName)}</div>
            <div class="doc-meta">${fmtSize(d.size)} · ${avatar(d.uploadedBy)} ${esc(d.uploadedBy)} · ${timeAgo(d.createdAt)}</div>
          </div>
          <button class="icon-btn doc-menu" data-menu="${d.id}" title="More actions">⋯</button>
        </div>`).join('')}</div>
      ${list.length ? '' : '<div class="empty-state">No documents match your search.</div>'}`
    : `<div class="doc-drop" id="docDrop">${PDF_ICON}<h2>No documents yet</h2><p>Drop PDF files here, or</p><button class="btn btn-primary" id="docUpload2">Choose PDFs</button></div>`}
    <div class="doc-overlay hidden" id="docOverlay"><div>${PDF_ICON}<b>Drop PDFs to upload</b></div></div>`;
  bindHeader(root);

  const pick = async () => { const files = await window.taskflow.docs.pick(); if (files.length) openNameDialog(files); };
  $('#docUpload').onclick = pick;
  $('#docUpload2')?.addEventListener('click', pick);
  const dq = $('#docQ');
  if (dq) dq.oninput = () => { DOCS.q = dq.value; const pos = dq.selectionStart; render(); const n = $('#docQ'); n.focus(); n.setSelectionRange(pos, pos); };

  $$('.doc-card', root).forEach(c => c.onclick = (e) => { if (!e.target.closest('.doc-menu')) openDoc(c.dataset.doc); });
  $$('[data-menu]', root).forEach(b => b.onclick = (e) => {
    e.stopPropagation(); closeDropdowns();
    const d = projectDocs().find(x => x.id === b.dataset.menu);
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    dd.innerHTML = `<div class="dropdown-item" data-a="open">Open</div><div class="dropdown-item" data-a="rename">Rename</div><div class="dropdown-item" data-a="show">Show in folder</div><div class="dropdown-sep"></div><div class="dropdown-item" data-a="del" style="color:var(--danger)">Delete</div>`;
    const r = b.getBoundingClientRect();
    dd.style.cssText = `position:fixed;top:${r.bottom + 4}px;left:${Math.max(8, r.right - 200)}px;min-width:200px`;
    document.body.appendChild(dd);
    dd.onclick = async (ev) => {
      ev.stopPropagation();
      const a = ev.target.closest('[data-a]')?.dataset.a; closeDropdowns();
      if (a === 'open') openDoc(d.id);
      if (a === 'show') window.taskflow.docs.show(d.id);
      if (a === 'rename') renameDoc(d);
      if (a === 'del' && await confirmModal(`Delete "${esc(d.name)}"?`, `The PDF (${d.fileName}) will be permanently removed from TaskFlow. Your original file on disk is not affected.`, 'Delete', true)) {
        await mutate('deleteDocument', d.id); toast(`"${d.name}" deleted`);
      }
    };
  });

  // Drag & drop upload anywhere on the page.
  const overlay = $('#docOverlay');
  let depth = 0;
  root.ondragenter = (e) => { if (!hasFiles(e)) return; depth++; overlay.classList.remove('hidden'); };
  root.ondragleave = (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; overlay.classList.add('hidden'); } };
  root.ondrop = async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; overlay.classList.add('hidden');
    const dropped = [...e.dataTransfer.files];
    const pdfs = dropped.filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (pdfs.length < dropped.length) toast(`${dropped.length - pdfs.length} file(s) skipped — only PDFs can be uploaded`, true);
    if (!pdfs.length) return;
    try { openNameDialog(await Promise.all(pdfs.map(f => window.taskflow.docs.fromDropped(f)))); }
    catch (err) { toast(err.message, true); }
  };
}

async function openDoc(id) {
  try { await window.taskflow.docs.open(id); } catch (e) { toast(`Could not open: ${e.message}`, true); }
}

// Step after picking/dropping files: give each one a name, then upload.
function openNameDialog(files) {
  const multi = files.length > 1;
  openModal(`
    <div class="modal-head"><h2>${multi ? `Upload ${files.length} PDFs` : 'Upload PDF'}</h2></div>
    <div class="modal-body">
      <p class="muted" style="margin-top:0">${multi ? 'Give each document a name.' : 'Give the document a name.'} It will be added to <b>${esc(project().name)}</b>.</p>
      ${files.map((f, n) => `<div class="doc-name-row">
        <div class="doc-thumb sm">${PDF_ICON}</div>
        <div style="flex:1;min-width:0">
          <div class="field" style="margin-bottom:4px"><label for="dn${n}">Document name <span class="req">*</span></label><input class="input" id="dn${n}" data-n="${n}" value="${esc(defaultDocName(f.name))}" maxlength="120" /></div>
          <div class="doc-meta">${esc(f.name)} · ${fmtSize(f.size)}</div>
          <div class="doc-row-err" data-err="${n}"></div>
        </div></div>`).join('')}
    </div>
    <div class="modal-foot"><button class="btn btn-subtle" data-close>Cancel</button><button class="btn btn-primary" id="docSave">Upload${multi ? ` ${files.length}` : ''}</button></div>`, 'form');
  const first = $('#dn0'); first.focus(); first.select();
  const pending = new Set(files.map((_, n) => n));
  const save = async () => {
    const btn = $('#docSave'); btn.disabled = true; btn.textContent = 'Uploading…';
    let done = 0;
    for (const n of [...pending]) {
      const input = $(`#dn${n}`), err = $(`[data-err="${n}"]`);
      if (!input.value.trim()) { err.textContent = 'Please enter a name'; continue; }
      try {
        await window.taskflow.call('addDocument', { project: S.projectId, filePath: files[n].path, name: input.value.trim() });
        pending.delete(n); done++;
        input.closest('.doc-name-row').classList.add('done'); err.textContent = '';
      } catch (e) { err.textContent = e.message; }
    }
    await load();
    if (done) toast(done === 1 ? `"${files.length === 1 ? $('#dn0').value.trim() : 'Document'}" uploaded` : `${done} documents uploaded`);
    if (!pending.size) closeModal();
    else { btn.disabled = false; btn.textContent = `Upload ${pending.size} remaining`; $(`#dn${[...pending][0]}`).focus(); }
  };
  $('#docSave').onclick = save;
  $$('[data-n]').forEach(i => i.onkeydown = (e) => { if (e.key === 'Enter') save(); });
}

function renameDoc(d) {
  openModal(`<div class="modal-head"><h2>Rename document</h2></div>
    <div class="modal-body"><div class="field"><label>Name</label><input class="input" id="rnName" value="${esc(d.name)}" maxlength="120" /></div><div class="doc-row-err" id="rnErr"></div></div>
    <div class="modal-foot"><button class="btn btn-subtle" data-close>Cancel</button><button class="btn btn-primary" id="rnOk">Save</button></div>`, 'form');
  const input = $('#rnName'); input.focus(); input.select();
  const save = async () => {
    try { await window.taskflow.call('renameDocument', d.id, input.value); closeModal(); await load(); toast('Document renamed'); }
    catch (e) { $('#rnErr').textContent = e.message; }
  };
  $('#rnOk').onclick = save;
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
}
