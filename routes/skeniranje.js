const express = require('express');
const multer = require('multer');
const { parseNalogWorkbook, parseSkenoviCsv, computeStatus, applyProductionPlanStatus, DEFAULT_DUALPHASE_KEYWORDS, opisMatchKey } = require('../lib/parse');
const { loadJson, saveJson, deleteKey, loadAllByPrefix, deleteAllByPrefix } = require('../lib/store');
const { enrichWithTrello } = require('../lib/trello');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Podaci se spremaju u Supabase (tablica kv_store), pa ostaju trajno
// sačuvani i preživljavaju restart/redeploy Render servisa.
// Svaki radni nalog ide u SVOJ VLASTITI redak (ključ "nalog:{nalogBase}"),
// ne kao jedan veliki objekt sa svim nalozima - kod tisuća naloga bi
// učitavanje/prepisivanje jednog golemog bloka kod svakog uploada bilo
// presporo i riskiralo limite veličine.
const SKENOVI_KEY = 'skenovi';
const DUALPHASE_KEY = 'dvofaznePozicije';
const PREONLY_KEY = 'samoPrijeObradePozicije';
const NALOG_PREFIX = 'nalog:';

function loadNalozi() { return loadAllByPrefix(NALOG_PREFIX); }
function loadSkenovi() { return loadJson(SKENOVI_KEY, { byKey: {}, meta: null }); }
function loadDualPhaseKeywords() { return loadJson(DUALPHASE_KEY, DEFAULT_DUALPHASE_KEYWORDS); }
function loadPreOnlyKeywords() { return loadJson(PREONLY_KEY, []); }

// Svede golemi skup svih naloga (može biti 10.000+) na samo one koji
// pripadaju ISTOM PROJEKTU kao ciljani nalog (potrebno za ispravno
// povezivanje s NS/Trello/ASL planom), umjesto da se svaki put obrađuju
// svi naloge - to bi kod velikog broja naloga bilo presporo (timeout).
function filterNalozByProject(nalozi, targetNalogBase) {
  const target = nalozi[targetNalogBase];
  if (!target) return { [targetNalogBase]: undefined }; // ostavi da glavna ruta javi 404
  const projectKey = opisMatchKey(target.opis) || targetNalogBase;
  const filtered = {};
  for (const key of Object.keys(nalozi)) {
    const n = nalozi[key];
    const nKey = opisMatchKey(n.opis) || key;
    if (nKey === projectKey || key === targetNalogBase) filtered[key] = n;
  }
  return filtered;
}

// --- Dvofazne oznake (npr. "fin", "soffit") - uredljiv popis koji određuje
// koje pozicije trebaju sken PRIJE i NAKON CNC obrade da bi bile potpuno
// gotove. Vidi PROCITAJ.md za objašnjenje logike. ---
router.get('/api/dvofazne-oznake', async (req, res) => {
  try {
    const keywords = await loadDualPhaseKeywords();
    res.json({ keywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/dvofazne-oznake', async (req, res) => {
  try {
    const keywords = Array.isArray(req.body.keywords)
      ? req.body.keywords.map(k => String(k).trim()).filter(Boolean)
      : [];
    await saveJson(DUALPHASE_KEY, keywords);
    res.json({ ok: true, keywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- "Samo prije obrade" oznake - pozicije kojima je dovoljan SAMO sken
// prije CNC obrade (preko NS-a), bez potrebe za dodatnim skenom nakon. ---
router.get('/api/samo-prije-oznake', async (req, res) => {
  try {
    const keywords = await loadPreOnlyKeywords();
    res.json({ keywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/api/samo-prije-oznake', async (req, res) => {
  try {
    const keywords = Array.isArray(req.body.keywords)
      ? req.body.keywords.map(k => String(k).trim()).filter(Boolean)
      : [];
    await saveJson(PREONLY_KEY, keywords);
    res.json({ ok: true, keywords });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Upload radnih naloga (jedan ili više .xlsx/.xlsm) ---
router.post('/api/nalozi', upload.array('files', 100), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nema poslanih datoteka.' });
  }
  const rezultati = [];
  const greske = [];

  // Svaki fajl parsiramo i spremamo NEOVISNO o ostalima - ne treba
  // učitavati postojeće naloge (upsert po ključu, ne prepisivanje svega).
  for (const file of req.files) {
    try {
      const parsed = parseNalogWorkbook(file.buffer, file.originalname);
      await saveJson(NALOG_PREFIX + parsed.nalogBase, parsed);
      rezultati.push({ file: file.originalname, nalogBase: parsed.nalogBase, stavki: parsed.items.length });
    } catch (e) {
      greske.push({ file: file.originalname, error: e.message });
    }
  }

  res.json({ ok: true, uneseno: rezultati, greske });
});

// --- Upload CSV skenova (zamjenjuje trenutni skup skenova cijelim novim izvozom) ---
router.post('/api/skenovi', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nema poslane CSV datoteke.' });
  try {
    const { byKey, skippedRows, totalRows, otherFormats } = parseSkenoviCsv(req.file.buffer);
    const meta = {
      sourceFile: req.file.originalname,
      uploadedAt: new Date().toISOString(),
      totalRows,
      skippedRows,
      uniquePositions: Object.keys(byKey).length,
      otherFormats
    };
    await saveJson(SKENOVI_KEY, { byKey, meta });
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Status: spoji naloge + skenove + (ako je konfiguriran) Trello CNC status ---
// Kod velikog broja naloga (tisuće) NE šaljemo pune podatke (pozicije po
// nalogu) za sve odjednom - to bi zaledilo browser. Bez pretrage vraćamo
// samo sažetak (bez pozicija); s pretragom vraćamo pune podatke, ali SAMO
// za naloge koji odgovaraju pretrazi (i najviše FULL_LIMIT njih).
const FULL_LIMIT = 300;

router.get('/api/status', async (req, res) => {
  try {
    const nalozi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const preOnlyKeywords = await loadPreOnlyKeywords();
    const search = (req.query.search || '').trim().toLowerCase();

    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords, preOnlyKeywords);
    const forceRefresh = req.query.trelloRefresh === '1';
    const { trelloInfo } = await enrichWithTrello(status, forceRefresh);
    applyProductionPlanStatus(status); // mora ići NAKON Trello obogaćivanja (koristi cncGotovo)

    if (search) {
      const matched = status.filter(n => {
        const itemMatch = n.items.some(it =>
          (it.partNumber || '').toLowerCase().includes(search) ||
          (it.description || '').toLowerCase().includes(search)
        );
        const planMatch = n.productionPlanStatus && n.productionPlanStatus.some(pe =>
          (pe.partNumber || '').toLowerCase().includes(search) ||
          (pe.description || '').toLowerCase().includes(search)
        );
        return itemMatch || planMatch;
      });
      res.json({
        mode: 'full',
        nalozi: matched.slice(0, FULL_LIMIT),
        totalMatched: matched.length,
        truncated: matched.length > FULL_LIMIT,
        totalNalozi: status.length,
        skenoviMeta: skenoviData.meta || null,
        trelloInfo
      });
    } else {
      // Grupiraj po projektu (isti "opis" kod bez dodatka odjela, npr.
      // "1096-1-ELE-B1X-01") - unutar projekta obično postoje odvojeni
      // naloge po odjelu (CNC, SSP, ASL, INC, PAW...). Ovo olakšava
      // snalaženje kroz veliki broj naloga u sažetku.
      const groupsMap = new Map();
      for (const n of status) {
        const key = opisMatchKey(n.opis) || n.nalogBase;
        if (!groupsMap.has(key)) {
          groupsMap.set(key, { projectKey: key, projekt: n.projekt, opisBase: null, children: [] });
        }
        const group = groupsMap.get(key);
        if (!group.opisBase) {
          const full = String(n.opis || '').trim();
          group.opisBase = full.split(/\s+-\s+/)[0].trim() || key;
        }
        if (!group.projekt && n.projekt) group.projekt = n.projekt;
        group.children.push({
          nalogBase: n.nalogBase, nalogPuni: n.nalogPuni, opis: n.opis, odjel: n.odjel,
          format: n.format, total: n.total, done: n.done, partial: n.partial,
          missing: n.missing, percent: n.percent, trelloCard: n.trelloCard || null
        });
      }

      const groups = Array.from(groupsMap.values())
        .filter(g => g.children.some(c => c.format === 'RN')) // NS-only projekte (bez ijednog RN naloga) ne prikazujemo - to su samo pozadinski podaci za usporedbu
        .map(g => {
        const rnChildren = g.children.filter(c => c.format === 'RN'); // NS naloge se koriste samo u pozadini, ne prikazuju se ni u zbroju ni u popisu
        const total = rnChildren.reduce((s, c) => s + c.total, 0);
        const done = rnChildren.reduce((s, c) => s + c.done, 0);
        const partial = rnChildren.reduce((s, c) => s + c.partial, 0);
        rnChildren.sort((a, b) => (a.odjel || '').localeCompare(b.odjel || ''));
        return {
          projectKey: g.projectKey,
          projekt: g.projekt,
          opisBase: g.opisBase,
          total, done, partial,
          percent: total > 0 ? Math.round((done / total) * 1000) / 10 : 0,
          brojNaloga: rnChildren.length,
          children: rnChildren
        };
      });
      groups.sort((a, b) => a.opisBase.localeCompare(b.opisBase));

      res.json({
        mode: 'summary',
        grupe: groups,
        totalNalozi: status.length,
        skenoviMeta: skenoviData.meta || null,
        trelloInfo
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Puni detalj za JEDAN nalog (klik na redak u sažetku) ---
router.get('/api/status/:nalogBase', async (req, res) => {
  try {
    const svi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const preOnlyKeywords = await loadPreOnlyKeywords();
    const key = req.params.nalogBase.toUpperCase();

    if (!svi[key]) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    const nalozi = filterNalozByProject(svi, key);

    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords, preOnlyKeywords);
    await enrichWithTrello(status, false);
    applyProductionPlanStatus(status);

    const nalog = status.find(n => n.nalogBase === key);
    if (!nalog) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    res.json({ nalog });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Obriši SVE naloge odjednom ---
router.delete('/api/nalozi', async (req, res) => {
  try {
    await deleteAllByPrefix(NALOG_PREFIX);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Obriši jedan radni nalog ---
router.delete('/api/nalozi/:nalogBase', async (req, res) => {
  try {
    const key = req.params.nalogBase.toUpperCase();
    const existing = await loadJson(NALOG_PREFIX + key, null);
    if (!existing) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    await deleteKey(NALOG_PREFIX + key);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function toCsvValue(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function stepsToText(techSteps, qty) {
  if (!techSteps || techSteps.length === 0) return '';
  return techSteps.map(s => {
    const done = s.gotovoKolicina != null ? s.gotovoKolicina : 0;
    return `${s.naziv} ${done}/${qty ?? '?'}`;
  }).join('; ');
}

function statusToMissingCsv(statusList) {
  const header = ['Radni nalog', 'Projekt', 'Item', 'Part Number', 'Opis', 'Finishing', 'Boja', 'Kolicina', 'Skenirano komada', 'Status', 'Prije obrade (NS)', 'Nakon obrade (RN)', 'Stanica', 'CNC stroj', 'CNC gotovo', 'Koraci proizvodnje', 'UOM'];
  const lines = [header.join(',')];
  for (const nalog of statusList) {
    for (const it of nalog.items) {
      if (it.statusSkeniranja === 'potpuno') continue;
      const statusText = it.statusSkeniranja === 'djelomicno' ? 'djelomicno' : 'nije skenirano';
      const cncText = it.cncGotovo === null || it.cncGotovo === undefined ? '' : (it.cncGotovo ? 'da' : 'ne');
      const prijeText = it.faze ? `${it.faze.prijeObrade.komada}/${it.qty ?? '?'} (${it.faze.prijeObrade.status})` : '';
      const nakonText = it.faze ? `${it.faze.nakonObrade.komada}/${it.qty ?? '?'} (${it.faze.nakonObrade.status})` : '';
      lines.push([
        nalog.nalogPuni, nalog.projekt, it.item, it.partNumber, it.description, it.finishing, it.colorName,
        it.qty, it.komadaSkenirano, statusText, prijeText, nakonText, (it.stanice || []).join('; '), it.cncStroj || '', cncText,
        stepsToText(it.techSteps, it.qty), it.uom
      ].map(toCsvValue).join(','));
    }
  }
  return lines.join('\r\n');
}

// --- CSV izvoz neskeniranih pozicija za jedan nalog ---
router.get('/api/export/:nalogBase.csv', async (req, res) => {
  try {
    const svi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const preOnlyKeywords = await loadPreOnlyKeywords();
    const key = req.params.nalogBase.toUpperCase();
    if (!svi[key]) return res.status(404).send('Nalog nije pronađen.');
    const nalozi = filterNalozByProject(svi, key);
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords, preOnlyKeywords).filter(n => n.nalogBase === key);
    if (status.length === 0) return res.status(404).send('Nalog nije pronađen.');
    await enrichWithTrello(status, false);
    const csv = statusToMissingCsv(status);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${key}_neskenirano.csv"`);
    res.send('\uFEFF' + csv); // BOM radi ispravnog prikaza dijakritika u Excelu
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// --- CSV izvoz svih neskeniranih pozicija ---
router.get('/api/export-all.csv', async (req, res) => {
  try {
    const nalozi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const preOnlyKeywords = await loadPreOnlyKeywords();
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords, preOnlyKeywords);
    await enrichWithTrello(status, false);
    applyProductionPlanStatus(status);
    const csv = statusToMissingCsv(status);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sve_neskenirano.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// --- Ispis: čist, printer-friendly prikaz svih pozicija jednog naloga ---
function escapeHtmlServer(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function statusLabel(s) {
  if (s === 'potpuno') return 'skenirano';
  if (s === 'djelomicno') return 'djelomično';
  return 'nije skenirano';
}

function stepsToPrintText(techSteps, qty) {
  if (!techSteps || techSteps.length === 0) return '';
  return techSteps.map(s => `${s.naziv} ${s.gotovoKolicina ?? 0}/${qty ?? '?'}`).join(', ');
}

function renderPrintPage(nalog) {
  const rows = nalog.items.map(it => `
    <tr>
      <td>${it.item}</td>
      <td>${escapeHtmlServer(it.partNumber)}</td>
      <td>${escapeHtmlServer(it.description)}</td>
      <td>${escapeHtmlServer(it.colorName || '')}</td>
      <td>${it.qty ?? ''}</td>
      <td class="${it.statusSkeniranja}">${statusLabel(it.statusSkeniranja)}</td>
      <td>${it.komadaSkenirano || ''}</td>
      <td>${escapeHtmlServer(it.cncStroj || '')}</td>
      <td>${it.cncGotovo === null || it.cncGotovo === undefined ? '' : (it.cncGotovo ? 'gotovo' : 'u tijeku')}</td>
      <td>${escapeHtmlServer(stepsToPrintText(it.techSteps, it.qty))}</td>
    </tr>
  `).join('');

  const planRows = nalog.productionPlanStatus ? nalog.productionPlanStatus.map(pe => `
    <tr>
      <td>${escapeHtmlServer(pe.partNumber)}</td>
      <td>${escapeHtmlServer(pe.description)}</td>
      <td>${pe.total ?? ''}</td>
      <td>${pe.skenirano}</td>
      <td class="${pe.status}">${statusLabel(pe.status)}</td>
    </tr>
  `).join('') : '';

  return `<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<title>Ispis - ${escapeHtmlServer(nalog.nalogPuni)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin: 20px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { color: #555; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; }
  th { background: #f0f0f0; }
  td.potpuno { color: #1b8a3e; font-weight: bold; }
  td.djelomicno { color: #b5750a; font-weight: bold; }
  td.nema { color: #c62828; font-weight: bold; }
  .print-btn { margin-bottom: 16px; }
  @media print {
    .print-btn { display: none; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Ispiši</button>
  <h1>${escapeHtmlServer(nalog.nalogPuni)} ${nalog.projekt ? '— ' + escapeHtmlServer(nalog.projekt) : ''}</h1>
  <div class="sub">${escapeHtmlServer(nalog.opis || '')} · ${nalog.done}/${nalog.total} pozicija (${nalog.percent}%) · Ispisano ${new Date().toLocaleString('hr-HR')}</div>

  <table>
    <thead><tr>
      <th>Item</th><th>Part Number</th><th>Opis</th><th>Boja</th><th>Kol.</th><th>Status</th><th># komada</th><th>CNC stroj</th><th>CNC</th><th>Koraci proizvodnje</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  ${nalog.productionPlanStatus ? `
  <h2>Plan proizvodnje (ASL)</h2>
  <table>
    <thead><tr><th>Part Number</th><th>Opis</th><th>Ukupno</th><th>Skenirano</th><th>Status</th></tr></thead>
    <tbody>${planRows}</tbody>
  </table>
  ` : ''}
</body>
</html>`;
}

router.get('/api/print/:nalogBase', async (req, res) => {
  try {
    const svi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const preOnlyKeywords = await loadPreOnlyKeywords();
    const key = req.params.nalogBase.toUpperCase();
    if (!svi[key]) return res.status(404).send('Nalog nije pronađen.');
    const nalozi = filterNalozByProject(svi, key);
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords, preOnlyKeywords).filter(n => n.nalogBase === key);
    if (status.length === 0) return res.status(404).send('Nalog nije pronađen.');
    await enrichWithTrello(status, false);
    applyProductionPlanStatus(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPrintPage(status[0]));
  } catch (e) {
    res.status(500).send('Greška: ' + e.message);
  }
});

module.exports = router;
