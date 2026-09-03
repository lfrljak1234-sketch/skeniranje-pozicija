const API = '/api';
let lastStatus = [];

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
document.getElementById('searchInput').addEventListener('input', render);

function refresh() {
  return refreshInternal(false);
}

async function refreshInternal(trelloRefresh) {
  const r = await fetch(API + '/status' + (trelloRefresh ? '?trelloRefresh=1' : ''));
  const data = await r.json();
  lastStatus = data.nalozi;
  const meta = data.skenoviMeta;
  const globalEl = document.getElementById('globalStatus');
  const parts = [];
  parts.push(meta
    ? `Skenovi učitani iz "${meta.sourceFile}" (${new Date(meta.uploadedAt).toLocaleString('hr-HR')})`
    : 'Skenovi još nisu uploadani.');
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

function techStepsHtml(it) {
  if (!it.techSteps || it.techSteps.length === 0) return '';
  return it.techSteps.map(s => {
    const total = it.qty;
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
    </tr>
  `).join('');
  if (!rows) rows = '<tr><td colspan="5" class="muted">Nema pozicija za prikaz.</td></tr>';

  const table = document.createElement('table');
  table.innerHTML = `
    <thead><tr><th>Part Number</th><th>Opis</th><th>Ukupno</th><th>Skenirano</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  `;
  wrap.appendChild(table);
  return wrap;
}

function render() {
  const onlyMissing = document.getElementById('onlyMissing').checked;
  const search = document.getElementById('searchInput').value.trim().toLowerCase();
  const root = document.getElementById('nalozi');
  root.innerHTML = '';

  if (lastStatus.length === 0) {
    root.innerHTML = '<div class="card muted">Nema još uploadanih radnih naloga.</div>';
    return;
  }

  function matchesSearch(it) {
    if (!search) return true;
    return (it.partNumber || '').toLowerCase().includes(search) ||
           (it.description || '').toLowerCase().includes(search);
  }

  let anyRendered = false;

  for (const nalog of lastStatus) {
    const searchMatchCount = nalog.items.filter(matchesSearch).length;
    const planMatchCount = nalog.productionPlanStatus
      ? nalog.productionPlanStatus.filter(pe =>
          !search ||
          (pe.partNumber || '').toLowerCase().includes(search) ||
          (pe.description || '').toLowerCase().includes(search)
        ).length
      : 0;
    if (search && searchMatchCount === 0 && planMatchCount === 0) continue; // nalog nema nijednu pogodenu poziciju - preskoci
    anyRendered = true;

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
        <button class="danger" onclick="event.stopPropagation(); obrisiNalog('${nalog.nalogBase}')">Obriši</button>
      </div>
    `;
    header.addEventListener('click', () => {
      body.classList.toggle('open');
    });

    const body = document.createElement('div');
    body.className = 'items-body';
    if (search) body.classList.add('open'); // auto-otvori naloge s pogotkom

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
    root.appendChild(wrap);
  }

  if (!anyRendered) {
    root.innerHTML = `<div class="card muted">Nema pozicija koje odgovaraju pretrazi "${escapeHtml(search)}".</div>`;
  }
}

async function obrisiNalog(nalogBase) {
  if (!confirm(`Obrisati radni nalog ${nalogBase}?`)) return;
  await fetch(API + '/nalozi/' + nalogBase, { method: 'DELETE' });
  refresh();
}

refresh();
