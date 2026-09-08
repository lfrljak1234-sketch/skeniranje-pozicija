const API = '/api';
let lastStatus = [];
let lastMode = 'summary';
let lastMeta = {};
let searchDebounceTimer = null;

function setupDrop(boxId, inputId, onFiles) {
  const box = document.getElementById(boxId);
  const input = document.getElementById(inputId);
  input.addEventListener('change', () => onFiles(input.files));
  ['dragenter', 'dragover'].forEach(ev =>
    box.addEventListener(ev, e => { e.preventDefault(); box.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    box.addEventListener(ev, e => { e.preventDefault(); box.classList.remove('drag'); }));
  box.addEventListener('drop', e => {
    if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
  });
}

setupDrop('boxNalozi', 'inputNalozi', async (files) => {
  const statusEl = document.getElementById('statusNalozi');
  statusEl.textContent = 'Šaljem...';
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  try {
    const r = await fetch(API + '/nalozi', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Greška pri uploadu.');
    let msg = `Uneseno: ${data.uneseno.map(u => u.nalogBase + ' (' + u.stavki + ' pozicija)').join(', ') || '-'}`;
    if (data.greske.length) msg += ` | Greške: ${data.greske.map(g => g.file + ': ' + g.error).join('; ')}`;
    statusEl.textContent = msg;
  } catch (e) {
    statusEl.textContent = 'Greška: ' + e.message;
  }
  refresh();
});

setupDrop('boxSkenovi', 'inputSkenovi', async (files) => {
  const statusEl = document.getElementById('statusSkenovi');
  statusEl.textContent = 'Šaljem...';
  const fd = new FormData();
  fd.append('file', files[0]);
  try {
    const r = await fetch(API + '/skenovi', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Greška pri uploadu.');
    statusEl.textContent = `Učitano ${data.meta.totalRows} redaka, ${data.meta.uniquePositions} jedinstvenih pozicija` +
      (data.meta.skippedRows ? `, preskočeno ${data.meta.skippedRows} redaka koji ne odgovaraju RN_pozicija obrascu (drugi format oznaka ili prazni skenovi)` : '');
  } catch (e) {
    statusEl.textContent = 'Greška: ' + e.message;
  }
  refresh();
});

document.getElementById('onlyMissing').addEventListener('change', render);
document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => refreshInternal(false), 350);
});

// --- Dvofazne oznake ---
let dualPhaseKeywords = [];

function toggleDualPhasePanel() {
  const panel = document.getElementById('dualPhasePanel');
  const showing = panel.style.display !== 'none';
  if (showing) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  ucitajDvofazneOznake();
}

async function ucitajDvofazneOznake() {
  const statusEl = document.getElementById('dualPhaseStatus');
  try {
    const r = await fetch(API + '/dvofazne-oznake');
    const data = await r.json();
    dualPhaseKeywords = data.keywords || [];
    renderDvofazneOznake();
  } catch (e) {
    statusEl.textContent = 'Greška pri učitavanju: ' + e.message;
  }
}

function renderDvofazneOznake() {
  const wrap = document.getElementById('dualPhaseTags');
  wrap.innerHTML = dualPhaseKeywords.map((k, i) => `
    <span class="tag-chip">${escapeHtml(k)} <button onclick="obrisiDvofaznuOznaku(${i})" title="Ukloni">×</button></span>
  `).join('') || '<span class="muted">Nema oznaka.</span>';
}

async function spremiDvofazneOznake() {
  const statusEl = document.getElementById('dualPhaseStatus');
  statusEl.textContent = 'Spremam...';
  try {
    const r = await fetch(API + '/dvofazne-oznake', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: dualPhaseKeywords })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Greška pri spremanju.');
    statusEl.textContent = 'Spremljeno.';
    refresh();
  } catch (e) {
    statusEl.textContent = 'Greška: ' + e.message;
  }
}

function dodajDvofaznuOznaku() {
  const input = document.getElementById('dualPhaseInput');
  const val = input.value.trim();
  if (!val) return;
  if (dualPhaseKeywords.some(k => k.toLowerCase() === val.toLowerCase())) {
    input.value = '';
    return;
  }
  dualPhaseKeywords.push(val);
  input.value = '';
  renderDvofazneOznake();
  spremiDvofazneOznake();
}

function obrisiDvofaznuOznaku(i) {
  dualPhaseKeywords.splice(i, 1);
  renderDvofazneOznake();
  spremiDvofazneOznake();
}

document.getElementById('dualPhaseInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dodajDvofaznuOznaku();
});

function refresh() {
  return refreshInternal(false);
}

async function refreshInternal(trelloRefresh) {
  const search = document.getElementById('searchInput').value.trim();
  const params = new URLSearchParams();
  if (trelloRefresh) params.set('trelloRefresh', '1');
  if (search) params.set('search', search);
  const r = await fetch(API + '/status' + (params.toString() ? '?' + params.toString() : ''));
  const data = await r.json();
  lastMode = data.mode || 'summary';
  lastStatus = lastMode === 'summary' ? (data.grupe || []) : (data.nalozi || []);
  lastMeta = data;
  const meta = data.skenoviMeta;
  const globalEl = document.getElementById('globalStatus');
  const parts = [];
  parts.push(meta
    ? `Skenovi učitani iz "${meta.sourceFile}" (${new Date(meta.uploadedAt).toLocaleString('hr-HR')})`
    : 'Skenovi još nisu uploadani.');
  parts.push(`${data.totalNalozi} naloga ukupno`);
  if (data.trelloInfo && data.trelloInfo.configured) {
    if (data.trelloInfo.ok) {
      parts.push(`Trello CNC podaci osvježeni ${new Date(data.trelloInfo.cachedAt).toLocaleTimeString('hr-HR')}`);
    } else {
      parts.push(`Trello greška: ${data.trelloInfo.error}`);
    }
  }
  globalEl.textContent = parts.join(' · ');
  render();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function colorCellHtml(it) {
  const text = it.finishing ? escapeHtml(it.finishing) : 'nepoznato';
  return `<span class="color-cell" title="${text}">${text}</span>`;
}

function statusBadgeHtml(it) {
  if (it.faze) {
    // Fin/soffit pozicija - prikaži obje faze eksplicitno
    const p = it.faze.prijeObrade, n = it.faze.nakonObrade;
    const cls = s => s === 'potpuno' ? 'ok' : (s === 'djelomicno' ? 'partial' : 'miss');
    const kol = it.qty != null ? '/' + it.qty : '';
    return `<span class="badge ${cls(p.status)}" title="Prije obrade (NS)">prije: ${p.komada}${kol}</span> ` +
           `<span class="badge ${cls(n.status)}" title="Nakon obrade (RN)">nakon: ${n.komada}${kol}</span>`;
  }
  if (it.statusSkeniranja === 'potpuno') {
    return `<span class="badge ok">skenirano</span>`;
  }
  if (it.statusSkeniranja === 'djelomicno') {
    const kol = it.qty != null ? `${it.komadaSkenirano}/${it.qty}` : it.komadaSkenirano;
    return `<span class="badge partial">djelomično (${kol})</span>`;
  }
  return `<span class="badge miss">nije skenirano</span>`;
}

function cncBadgeHtml(it) {
  if (it.cncGotovo === null || it.cncGotovo === undefined) return '<span class="muted">—</span>';
  return it.cncGotovo
    ? '<span class="badge ok">gotovo</span>'
    : '<span class="badge miss">u tijeku</span>';
}

function techStepsHtml(it, qtyOverride) {
  if (!it.techSteps || it.techSteps.length === 0) return '';
  const total = qtyOverride !== undefined ? qtyOverride : it.qty;
  return it.techSteps.map(s => {
    const done = s.gotovoKolicina;
    let cls = 'step-pending';
    let text = escapeHtml(s.naziv);
    if (done != null && total != null) {
      cls = done >= total ? 'step-done' : (done > 0 ? 'step-partial' : 'step-pending');
      text += ` ${done}/${total}`;
    } else if (done != null) {
      cls = 'step-partial';
      text += ` ${done}`;
    }
    return `<span class="step-chip ${cls}">${text}</span>`;
  }).join(' ');
}

function productionPlanSection(nalog, search, onlyMissing) {
  const wrap = document.createElement('div');
  wrap.className = 'plan-section';

  let entries = nalog.productionPlanStatus;
  if (search) {
    entries = entries.filter(pe =>
      (pe.partNumber || '').toLowerCase().includes(search) ||
      (pe.description || '').toLowerCase().includes(search)
    );
  }
  if (onlyMissing) entries = entries.filter(pe => pe.status !== 'potpuno');

  const doneCount = nalog.productionPlanStatus.filter(pe => pe.status === 'potpuno').length;
  const title = document.createElement('div');
  title.className = 'plan-title';
  title.textContent = `Plan proizvodnje (ASL) — ${doneCount}/${nalog.productionPlanStatus.length} gotovo (usporedba sa svim uploadanim nalozima ovog projekta)`;
  wrap.appendChild(title);

  let rows = entries.map(pe => `
    <tr class="${pe.status === 'potpuno' ? 'done' : (pe.status === 'djelomicno' ? 'partial' : 'missing')}">
      <td>${escapeHtml(pe.partNumber)}</td>
      <td>${escapeHtml(pe.description)}</td>
      <td>${pe.total ?? ''}</td>
      <td>${pe.skenirano}</td>
      <td class="status">${pe.status === 'potpuno'
        ? '<span class="badge ok">gotovo</span>'
        : (pe.status === 'djelomicno'
          ? `<span class="badge partial">djelomično (${pe.skenirano}/${pe.total ?? '?'})</span>`
          : '<span class="badge miss">nije skenirano</span>')}
      </td>
      <td>${escapeHtml(pe.cncStroj || '')}</td>
      <td>${cncBadgeHtml(pe)}</td>
      <td>${techStepsHtml(pe, pe.total)}</td>
    </tr>
  `).join('');
  if (!rows) rows = '<tr><td colspan="8" class="muted">Nema pozicija za prikaz.</td></tr>';

  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Part Number</th><th>Opis</th><th>Ukupno</th><th>Skenirano</th><th>Status</th><th>CNC stroj</th><th>CNC</th><th>Koraci proizvodnje</th></tr></thead>
    <tbody>${rows}</tbody>
  `;
  wrap.appendChild(table);
  return wrap;
}

function render() {
  if (lastMode === 'summary') {
    renderSummary();
  } else {
    renderFull();
  }
}

function renderSummary() {
  const onlyMissing = document.getElementById('onlyMissing').checked;
  const root = document.getElementById('nalozi');

  if (lastStatus.length === 0) {
    root.innerHTML = '<div class="card muted">Nema još uploadanih radnih naloga.</div>';
    return;
  }

  const groups = onlyMissing ? lastStatus.filter(g => g.done < g.total) : lastStatus;
  const totalNaloga = lastStatus.reduce((s, g) => s + g.brojNaloga, 0);

  const rowsHtml = groups.map(g => `
    <tr class="clickable-row group-row ${g.done >= g.total ? 'done' : (g.partial > 0 || g.done > 0 ? 'partial' : 'missing')}" data-project="${escapeHtml(g.projectKey)}">
      <td><span class="expand-arrow">▸</span> ${escapeHtml(g.opisBase)}</td>
      <td>${escapeHtml(g.projekt || '')}</td>
      <td>${g.brojNaloga} naloga</td>
      <td>${g.done}/${g.total}${g.partial ? ` (${g.partial} djelomično)` : ''}</td>
      <td>${g.percent}%</td>
    </tr>
    <tr class="children-row" id="children-${cssId(g.projectKey)}" style="display:none;"><td colspan="5"></td></tr>
  `).join('');

  root.innerHTML = `
    <div class="card muted" style="margin-bottom:10px;">
      Prikazano ${lastStatus.length} projekata (${totalNaloga} naloga ukupno), grupirano po projektnom kodu —
      velik broj naloga se ne iscrtava odjednom u punom detalju jer bi to usporilo browser. Upiši šifru ili
      opis u polje za pretragu gore da vidiš pune pozicije za konkretan nalog, ili <strong>klikni na projekt</strong>
      da vidiš njegove naloge po odjelu (CNC, SSP, ASL...), pa na pojedini nalog za pune pozicije.
    </div>
    <table>
      <thead><tr>
        <th>Projekt (kod)</th><th>Naziv projekta</th><th>Broj naloga</th><th>Gotovo</th><th>%</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;

  root.querySelectorAll('tr.group-row').forEach(tr => {
    tr.addEventListener('click', () => toggleGroup(tr.dataset.project));
  });
}

function cssId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toggleGroup(projectKey) {
  const row = document.getElementById('children-' + cssId(projectKey));
  const cell = row.querySelector('td');
  const arrow = document.querySelector(`tr.group-row[data-project="${CSS.escape(projectKey)}"] .expand-arrow`);

  if (row.style.display !== 'none') {
    row.style.display = 'none';
    if (arrow) arrow.textContent = '▸';
    return;
  }

  const group = lastStatus.find(g => g.projectKey === projectKey);
  const childRows = group.children.map(c => `
    <tr class="clickable-row" data-nalog="${c.nalogBase}">
      <td>${escapeHtml(c.odjel || c.format)}</td>
      <td>${escapeHtml(c.nalogPuni)}</td>
      <td>${c.done}/${c.total}${c.partial ? ` (${c.partial} djelomično)` : ''}</td>
      <td>${c.percent}%</td>
      <td>${c.trelloCard ? escapeHtml((c.trelloCard.machines || []).join(', ')) : ''}</td>
      <td><a class="btn secondary" href="/api/export/${c.nalogBase}.csv" onclick="event.stopPropagation()">CSV</a> <a class="btn secondary" href="/api/print/${c.nalogBase}" target="_blank" onclick="event.stopPropagation()">Ispis</a> <button class="danger" onclick="event.stopPropagation(); obrisiNalog('${c.nalogBase}')">Obriši</button></td>
    </tr>
    <tr class="detail-row" id="detail-${c.nalogBase}" style="display:none;"><td colspan="6"></td></tr>
  `).join('');

  cell.innerHTML = `
    <table class="child-table">
      <thead><tr><th>Odjel</th><th>Radni nalog</th><th>Gotovo</th><th>%</th><th>CNC strojevi</th><th></th></tr></thead>
      <tbody>${childRows}</tbody>
    </table>
  `;
  cell.querySelectorAll('tr.clickable-row').forEach(tr => {
    tr.addEventListener('click', () => toggleNalogDetail(tr.dataset.nalog));
  });

  row.style.display = 'table-row';
  if (arrow) arrow.textContent = '▾';
}

async function toggleNalogDetail(nalogBase) {
  const detailRow = document.getElementById('detail-' + nalogBase);
  const cell = detailRow.querySelector('td');

  if (detailRow.style.display !== 'none') {
    detailRow.style.display = 'none';
    return;
  }

  detailRow.style.display = 'table-row';
  cell.innerHTML = '<span class="muted">Učitavam pozicije...</span>';

  try {
    const r = await fetch(API + '/status/' + nalogBase);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Greška.');
    cell.innerHTML = '';
    cell.appendChild(renderNalogCard(data.nalog, '', { onlyMissing: document.getElementById('onlyMissing').checked, alwaysOpen: true }));
  } catch (e) {
    cell.innerHTML = '<span class="muted">Greška: ' + escapeHtml(e.message) + '</span>';
  }
}

function renderNalogCard(nalog, search, opts) {
  const onlyMissing = (opts && opts.onlyMissing) !== undefined
    ? opts.onlyMissing
    : document.getElementById('onlyMissing').checked;
  const alwaysOpen = !!(opts && opts.alwaysOpen);

  function matchesSearch(it) {
    if (!search) return true;
    return (it.partNumber || '').toLowerCase().includes(search) ||
           (it.description || '').toLowerCase().includes(search);
  }

  const searchMatchCount = nalog.items.filter(matchesSearch).length;

  const wrap = document.createElement('div');
  wrap.className = 'nalog-summary';

  const header = document.createElement('div');
  header.className = 'nalog-header';
  const partialNote = nalog.partial ? ` <span class="muted">(${nalog.partial} djelomično)</span>` : '';
  const trelloNote = nalog.trelloCard
    ? ` <span class="muted">· CNC strojevi: ${escapeHtml((nalog.trelloCard.machines || []).join(', ') || '?')} (${nalog.trelloCard.matchedCards} kartice)</span>`
    : '';
  const searchNote = search ? ` <span class="muted">· ${searchMatchCount} pogodaka</span>` : '';
  header.innerHTML = `
    <div>
      <h2>${nalog.nalogPuni} ${nalog.projekt ? '<span class="muted">— ' + nalog.projekt + '</span>' : ''}</h2>
      <div class="muted">${nalog.opis || ''}${trelloNote}${searchNote}</div>
    </div>
    <div class="progress-wrap">
      <span>${nalog.done}/${nalog.total}${partialNote}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${nalog.percent}%"></div></div>
      <span>${nalog.percent}%</span>
      <a class="btn secondary" href="/api/export/${nalog.nalogBase}.csv" onclick="event.stopPropagation()">CSV</a>
      <a class="btn secondary" href="/api/print/${nalog.nalogBase}" target="_blank" onclick="event.stopPropagation()">Ispis</a>
      <button class="danger" onclick="event.stopPropagation(); obrisiNalog('${nalog.nalogBase}')">Obriši</button>
    </div>
  `;

  const body = document.createElement('div');
  body.className = 'items-body';
  if (search || alwaysOpen) body.classList.add('open');

  if (!alwaysOpen) {
    header.addEventListener('click', () => {
      body.classList.toggle('open');
    });
  }

  let items = nalog.items.filter(matchesSearch);
  if (onlyMissing) items = items.filter(i => i.statusSkeniranja !== 'potpuno');
  let rows = items.map(it => `
    <tr class="${it.statusSkeniranja === 'potpuno' ? 'done' : (it.statusSkeniranja === 'djelomicno' ? 'partial' : 'missing')}">
      <td>${it.item}</td>
      <td>${it.partNumber}</td>
      <td>${it.description}</td>
      <td>${colorCellHtml(it)}</td>
      <td>${it.qty ?? ''}</td>
      <td class="status">${statusBadgeHtml(it)}</td>
      <td>${it.komadaSkenirano || ''}</td>
      <td>${(it.stanice || []).join(', ')}</td>
      <td>${it.zadnjiSken || ''}</td>
      <td>${escapeHtml(it.cncStroj || '')}</td>
      <td>${cncBadgeHtml(it)}</td>
      <td>${techStepsHtml(it)}</td>
    </tr>
  `).join('');
  if (!rows) rows = '<tr><td colspan="12" class="muted">Sve pozicije skenirane.</td></tr>';

  body.innerHTML = `
    <table>
      <thead><tr>
        <th>Item</th><th>Part Number</th><th>Opis</th><th>Boja</th><th>Kol.</th><th>Status</th><th># komada skenirano</th><th>Stanica</th><th>Zadnji sken</th><th>CNC stroj</th><th>CNC</th><th>Koraci proizvodnje</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  if (nalog.productionPlanStatus) {
    body.appendChild(productionPlanSection(nalog, search, onlyMissing));
  }

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

function renderFull() {
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const root = document.getElementById('nalozi');
  root.innerHTML = '';

  if (lastStatus.length === 0) {
    root.innerHTML = `<div class="card muted">Nema pozicija koje odgovaraju pretrazi "${escapeHtml(search)}".</div>`;
    return;
  }

  if (lastMeta.truncated) {
    const note = document.createElement('div');
    note.className = 'card muted';
    note.style.marginBottom = '10px';
    note.textContent = `Pronađeno ${lastMeta.totalMatched} naloga s pogotkom, prikazano prvih ${lastStatus.length}. Suzi pretragu za precizniji prikaz.`;
    root.appendChild(note);
  }

  for (const nalog of lastStatus) {
    root.appendChild(renderNalogCard(nalog, search));
  }
}

async function obrisiNalog(nalogBase) {
  if (!confirm(`Obrisati radni nalog ${nalogBase}?`)) return;
  await fetch(API + '/nalozi/' + nalogBase, { method: 'DELETE' });
  refresh();
}

async function obrisiSveNaloge() {
  const potvrda = prompt('Ovo briše SVE naloge (upisane skenove ne dira). Za potvrdu upiši: OBRISI');
  if (potvrda !== 'OBRISI') return;
  const globalEl = document.getElementById('globalStatus');
  globalEl.textContent = 'Brišem sve naloge...';
  const r = await fetch(API + '/nalozi', { method: 'DELETE' });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    globalEl.textContent = 'Greška: ' + (data.error || r.statusText);
    return;
  }
  refresh();
}

refresh();
