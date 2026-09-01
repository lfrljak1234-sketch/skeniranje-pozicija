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

async function refresh() {
  const r = await fetch(API + '/status');
  const data = await r.json();
  lastStatus = data.nalozi;
  const meta = data.skenoviMeta;
  const globalEl = document.getElementById('globalStatus');
  globalEl.textContent = meta
    ? `Skenovi učitani iz "${meta.sourceFile}" (${new Date(meta.uploadedAt).toLocaleString('hr-HR')})`
    : 'Skenovi još nisu uploadani.';
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
  if (it.statusSkeniranja === 'potpuno') {
    return `<span class="badge ok">skenirano</span>`;
  }
  if (it.statusSkeniranja === 'djelomicno') {
    const kol = it.qty != null ? `${it.komadaSkenirano}/${it.qty}` : it.komadaSkenirano;
    return `<span class="badge partial">djelomično (${kol})</span>`;
  }
  return `<span class="badge miss">nije skenirano</span>`;
}

function render() {
  const onlyMissing = document.getElementById('onlyMissing').checked;
  const root = document.getElementById('nalozi');
  root.innerHTML = '';

  if (lastStatus.length === 0) {
    root.innerHTML = '<div class="card muted">Nema još uploadanih radnih naloga.</div>';
    return;
  }

  for (const nalog of lastStatus) {
    const wrap = document.createElement('div');
    wrap.className = 'nalog-summary';

    const header = document.createElement('div');
    header.className = 'nalog-header';
    const partialNote = nalog.partial ? ` <span class="muted">(${nalog.partial} djelomično)</span>` : '';
    header.innerHTML = `
      <div>
        <h2>${nalog.nalogPuni} ${nalog.projekt ? '<span class="muted">— ' + nalog.projekt + '</span>' : ''}</h2>
        <div class="muted">${nalog.opis || ''}</div>
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

    const items = onlyMissing ? nalog.items.filter(i => i.statusSkeniranja !== 'potpuno') : nalog.items;
    let rows = items.map(it => `
      <tr class="${it.statusSkeniranja === 'potpuno' ? 'done' : (it.statusSkeniranja === 'djelomicno' ? 'partial' : 'missing')}">
        <td>${it.item}</td>
        <td>${it.partNumber}</td>
        <td>${it.description}</td>
        <td>${colorCellHtml(it)}</td>
        <td>${it.qty ?? ''}</td>
        <td class="status">${statusBadgeHtml(it)}</td>
        <td>${it.komadaSkenirano || ''}</td>
        <td>${it.zadnjiSken || ''}</td>
      </tr>
    `).join('');
    if (!rows) rows = '<tr><td colspan="8" class="muted">Sve pozicije skenirane.</td></tr>';

    body.innerHTML = `
      <table>
        <thead><tr>
          <th>Item</th><th>Part Number</th><th>Opis</th><th>Boja</th><th>Kol.</th><th>Status</th><th># komada skenirano</th><th>Zadnji sken</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    wrap.appendChild(header);
    wrap.appendChild(body);
    root.appendChild(wrap);
  }
}

async function obrisiNalog(nalogBase) {
  if (!confirm(`Obrisati radni nalog ${nalogBase}?`)) return;
  await fetch(API + '/nalozi/' + nalogBase, { method: 'DELETE' });
  refresh();
}

refresh();
