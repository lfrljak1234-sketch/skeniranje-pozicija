const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parseNalogWorkbook, parseSkenoviCsv, computeStatus } = require('../lib/parse');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Podaci se spremaju u data/ mapu (isti obrazac kao vikend-raspored aplikacija).
// NAPOMENA: na Render free planu disk je privremen - kod restarta/redeploya
// ovi podaci se gube. Radne naloge i zadnji CSV izvoz treba ponovno uploadati
// nakon svakog redeploya/restarta.
const DATA_DIR = path.join(__dirname, '..', 'data');
const NALOZI_FILE = path.join(DATA_DIR, 'nalozi.json');
const SKENOVI_FILE = path.join(DATA_DIR, 'skenovi.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('Greška pri čitanju', file, e.message);
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadNalozi() { return loadJson(NALOZI_FILE, {}); }
function loadSkenovi() { return loadJson(SKENOVI_FILE, { byKey: {}, meta: null }); }

// --- Upload radnih naloga (jedan ili više .xlsx/.xlsm) ---
router.post('/api/nalozi', upload.array('files', 100), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nema poslanih datoteka.' });
  }
  const nalozi = loadNalozi();
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

  saveJson(NALOZI_FILE, nalozi);
  res.json({ ok: true, uneseno: rezultati, greske });
});

// --- Upload CSV skenova (zamjenjuje trenutni skup skenova cijelim novim izvozom) ---
router.post('/api/skenovi', upload.single('file'), (req, res) => {
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
    saveJson(SKENOVI_FILE, { byKey, meta });
    res.json({ ok: true, meta });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Status: spoji naloge + skenove ---
router.get('/api/status', (req, res) => {
  const nalozi = loadNalozi();
  const skenoviData = loadSkenovi();
  const status = computeStatus(nalozi, skenoviData.byKey || {});
  res.json({ nalozi: status, skenoviMeta: skenoviData.meta || null });
});

// --- Obriši jedan radni nalog ---
router.delete('/api/nalozi/:nalogBase', (req, res) => {
  const nalozi = loadNalozi();
  const key = req.params.nalogBase.toUpperCase();
  if (!nalozi[key]) return res.status(404).json({ error: 'Nalog nije pronađen.' });
  delete nalozi[key];
  saveJson(NALOZI_FILE, nalozi);
  res.json({ ok: true });
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
  const header = ['Radni nalog', 'Projekt', 'Item', 'Part Number', 'Opis', 'Kolicina', 'UOM'];
  const lines = [header.join(',')];
  for (const nalog of statusList) {
    for (const it of nalog.items) {
      if (it.skenirano) continue;
      lines.push([
        nalog.nalogPuni, nalog.projekt, it.item, it.partNumber, it.description, it.qty, it.uom
      ].map(toCsvValue).join(','));
    }
  }
  return lines.join('\r\n');
}

// --- CSV izvoz neskeniranih pozicija za jedan nalog ---
router.get('/api/export/:nalogBase.csv', (req, res) => {
  const nalozi = loadNalozi();
  const skenoviData = loadSkenovi();
  const key = req.params.nalogBase.toUpperCase();
  const status = computeStatus(nalozi, skenoviData.byKey || {}).filter(n => n.nalogBase === key);
  if (status.length === 0) return res.status(404).send('Nalog nije pronađen.');
  const csv = statusToMissingCsv(status);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${key}_neskenirano.csv"`);
  res.send('\uFEFF' + csv); // BOM radi ispravnog prikaza dijakritika u Excelu
});

// --- CSV izvoz svih neskeniranih pozicija ---
router.get('/api/export-all.csv', (req, res) => {
  const nalozi = loadNalozi();
  const skenoviData = loadSkenovi();
  const status = computeStatus(nalozi, skenoviData.byKey || {});
  const csv = statusToMissingCsv(status);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sve_neskenirano.csv"');
  res.send('\uFEFF' + csv);
});

module.exports = router;
