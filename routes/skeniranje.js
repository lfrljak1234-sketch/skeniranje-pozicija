const express = require('express');
const multer = require('multer');
const { parseNalogWorkbook, parseSkenoviCsv, computeStatus, applyProductionPlanStatus, DEFAULT_DUALPHASE_KEYWORDS } = require('../lib/parse');
const { loadJson, saveJson } = require('../lib/store');
const { enrichWithTrello } = require('../lib/trello');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Podaci se spremaju u Supabase (tablica kv_store), pa ostaju trajno
// sačuvani i preživljavaju restart/redeploy Render servisa.
const NALOZI_KEY = 'nalozi';
const SKENOVI_KEY = 'skenovi';
const DUALPHASE_KEY = 'dvofaznePozicije';

function loadNalozi() { return loadJson(NALOZI_KEY, {}); }
function loadSkenovi() { return loadJson(SKENOVI_KEY, { byKey: {}, meta: null }); }
function loadDualPhaseKeywords() { return loadJson(DUALPHASE_KEY, DEFAULT_DUALPHASE_KEYWORDS); }

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

// --- Upload radnih naloga (jedan ili više .xlsx/.xlsm) ---
router.post('/api/nalozi', upload.array('files', 100), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nema poslanih datoteka.' });
  }
  try {
    const nalozi = await loadNalozi();
    const rezultati = [];
    const greske = [];

    for (const file of req.files) {
      try {
        const parsed = parseNalogWorkbook(file.buffer, file.originalname);
        nalozi[parsed.nalogBase] = parsed;
        rezultati.push({ file: file.originalname, nalogBase: parsed.nalogBase, stavki: parsed.items.length });
      } catch (e) {
        greske.push({ file: file.originalname, error: e.message });
      }
    }

    await saveJson(NALOZI_KEY, nalozi);
    res.json({ ok: true, uneseno: rezultati, greske });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
router.get('/api/status', async (req, res) => {
  try {
    const nalozi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords);
    const forceRefresh = req.query.trelloRefresh === '1';
    const { trelloInfo } = await enrichWithTrello(status, forceRefresh);
    applyProductionPlanStatus(status); // mora ići NAKON Trello obogaćivanja (koristi cncGotovo)
    res.json({ nalozi: status, skenoviMeta: skenoviData.meta || null, trelloInfo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Obriši jedan radni nalog ---
router.delete('/api/nalozi/:nalogBase', async (req, res) => {
  try {
    const nalozi = await loadNalozi();
    const key = req.params.nalogBase.toUpperCase();
    if (!nalozi[key]) return res.status(404).json({ error: 'Nalog nije pronađen.' });
    delete nalozi[key];
    await saveJson(NALOZI_KEY, nalozi);
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
    const nalozi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const key = req.params.nalogBase.toUpperCase();
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords).filter(n => n.nalogBase === key);
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
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords);
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
    const nalozi = await loadNalozi();
    const skenoviData = await loadSkenovi();
    const dualPhaseKeywords = await loadDualPhaseKeywords();
    const key = req.params.nalogBase.toUpperCase();
    const status = computeStatus(nalozi, skenoviData.byKey || {}, dualPhaseKeywords).filter(n => n.nalogBase === key);
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
