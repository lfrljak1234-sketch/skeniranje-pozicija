const express = require('express');
const multer = require('multer');
const { parseNalogWorkbook, parseSkenoviCsv, computeStatus } = require('../lib/parse');
const { loadJson, saveJson } = require('../lib/store');
const { enrichWithTrello } = require('../lib/trello');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Podaci se spremaju u Supabase (tablica kv_store), pa ostaju trajno
// sačuvani i preživljavaju restart/redeploy Render servisa.
const NALOZI_KEY = 'nalozi';
const SKENOVI_KEY = 'skenovi';

function loadNalozi() { return loadJson(NALOZI_KEY, {}); }
function loadSkenovi() { return loadJson(SKENOVI_KEY, { byKey: {}, meta: null }); }

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
    const status = computeStatus(nalozi, skenoviData.byKey || {});
    const forceRefresh = req.query.trelloRefresh === '1';
    const { trelloInfo } = await enrichWithTrello(status, forceRefresh);
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

function statusToMissingCsv(statusList) {
  const header = ['Radni nalog', 'Projekt', 'Item', 'Part Number', 'Opis', 'Finishing', 'Boja', 'Kolicina', 'Skenirano komada', 'Status', 'Stanica', 'CNC stroj', 'CNC gotovo', 'UOM'];
  const lines = [header.join(',')];
  for (const nalog of statusList) {
    for (const it of nalog.items) {
      if (it.statusSkeniranja === 'potpuno') continue;
      const statusText = it.statusSkeniranja === 'djelomicno' ? 'djelomicno' : 'nije skenirano';
      const cncText = it.cncGotovo === null || it.cncGotovo === undefined ? '' : (it.cncGotovo ? 'da' : 'ne');
      lines.push([
        nalog.nalogPuni, nalog.projekt, it.item, it.partNumber, it.description, it.finishing, it.colorName,
        it.qty, it.komadaSkenirano, statusText, (it.stanice || []).join('; '), it.cncStroj || '', cncText, it.uom
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
    const key = req.params.nalogBase.toUpperCase();
    const status = computeStatus(nalozi, skenoviData.byKey || {}).filter(n => n.nalogBase === key);
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
    const status = computeStatus(nalozi, skenoviData.byKey || {});
    await enrichWithTrello(status, false);
    const csv = statusToMissingCsv(status);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sve_neskenirano.csv"');
    res.send('\uFEFF' + csv);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

module.exports = router;
