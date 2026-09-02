const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');
const { extractRalCode, colorForFinishing } = require('./ral-colors');

// Izvuci "bazu" broja RN naloga iz stringa poput "RN31194_1" -> "RN31194"
// (radni nalog u ćeliji ima sufiks _1, _2..., ali skenovi barkodiraju
// pozicije direktno kao RN{broj}_{item}, bez tog dodatnog sufiksa)
function extractRnBase(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  const m = s.match(/^(RN\d+)/i);
  return m ? m[1].toUpperCase() : s.toUpperCase();
}

// --- Format 1: RN radni nalog (list "WorkingOrder") ---
// Pozicije se identificiraju rednim brojem ("Item"), skenovi barkodiraju
// kao RN{broj}_{item}.
function parseRnNalog(wb, sheetName, originalFilename) {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  let nalogPuni = null;
  let projekt = null;
  let opis = null;
  let odjel = null;
  let headerIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r[0] === 'Projekt' && projekt === null) projekt = r[2] || null;
    if (r[0] === 'Broj radnog naloga') nalogPuni = r[2] || null;
    if (r[0] === 'Broj specifikacije/povezani RNi') odjel = r[4] || null;
    if (r[0] === 'Opis RNa') opis = r[2] || null;
    if (r[0] === 'Item' && r[1] === 'Part Number') {
      headerIdx = i;
      break;
    }
  }

  if (!nalogPuni) {
    const m = originalFilename.match(/RN\d+(_\d+)?/i);
    nalogPuni = m ? m[0] : originalFilename;
  }
  if (headerIdx === -1) {
    throw new Error(`Ne mogu pronaći tablicu pozicija (red "Item / Part Number") u listu "${sheetName}".`);
  }

  const nalogBase = extractRnBase(nalogPuni);
  const nalogPuniNorm = String(nalogPuni).toUpperCase().trim();

  // Stupci TECH.STEP.N / QTY_STEP.N pronalazimo po nazivu (ne po fiksnoj
  // poziciji) - broj koraka zna varirati po nalogu.
  const headerRow = rows[headerIdx] || [];
  const stepCols = [];
  for (let i = 0; i < headerRow.length; i++) {
    const h = headerRow[i];
    if (h == null) continue;
    const m = String(h).trim().match(/^TECH\.STEP\.(\d+)$/i);
    if (!m) continue;
    const num = m[1];
    const qtyIdx = headerRow.findIndex(h2 =>
      h2 != null && String(h2).trim().toLowerCase() === ('qty_step.' + num).toLowerCase()
    );
    if (qtyIdx !== -1) stepCols.push({ techCol: i, qtyCol: qtyIdx, num: Number(num) });
  }
  stepCols.sort((a, b) => a.num - b.num);

  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const item = r[0];
    if (item === null || item === undefined || item === '') break; // kraj tablice
    if (typeof item !== 'number') continue;
    let finishing = r[4] != null ? String(r[4]).trim() : '';
    if (finishing === '-/-' || finishing === '-') finishing = ''; // "nije primjenjivo"

    const techSteps = [];
    for (const sc of stepCols) {
      const stepName = r[sc.techCol] != null ? String(r[sc.techCol]).trim() : '';
      if (!stepName || stepName === '-') continue; // korak se ne primjenjuje na ovu poziciju
      const doneQty = r[sc.qtyCol] != null ? r[sc.qtyCol] : null;
      techSteps.push({ redniBroj: sc.num, naziv: stepName, gotovoKolicina: doneQty });
    }

    items.push({
      item: Number(item),
      partNumber: r[1] != null ? String(r[1]).trim() : '',
      description: r[2] != null ? String(r[2]).trim() : '',
      finishing,
      ralCode: extractRalCode(finishing),
      colorName: finishing || null, // striktno onako kako piše u Excelu, bez obrade
      colorHex: colorForFinishing(finishing),
      qty: r[5] != null ? r[5] : null,
      uom: r[6] != null ? String(r[6]).trim() : '',
      pod: r[7] != null ? String(r[7]).trim() : '',
      techSteps,
      // dva moguća oblika ključa jer se barkod formata razlikovao kroz vrijeme
      scanKeys: [nalogBase + '_' + item, nalogPuniNorm + '_' + item]
    });
  }

  // TECH.STEP/QTY_STEP podaci se koriste samo za SSP naloge - CNC nalozi se
  // prate preko Trella, pa bi prikaz ovih (uglavnom praznih) stupaca za njih
  // bio zbunjujuć/pogrešan signal.
  const isSspDept = odjel ? /ssp/i.test(String(odjel)) : false;
  if (!isSspDept) {
    for (const it of items) it.techSteps = [];
  }

  return {
    format: 'RN',
    nalogBase,
    nalogPuni: String(nalogPuni),
    projekt: projekt ? String(projekt).trim() : null,
    opis: opis ? String(opis).trim() : null,
    odjel: odjel ? String(odjel).trim() : null,
    sourceFile: originalFilename,
    uploadedAt: new Date().toISOString(),
    items
  };
}

// --- Format 2: NS narudžba materijala (list "NarM") ---
// Pozicije nemaju čist redni broj kao ključ skena - barkod stupac u
// Excelu sadrži TOČAN tekst koji se skenira (npr. "23-1039_NS_1900_3B"),
// pa se taj tekst koristi izravno kao ključ.
function parseNsNalog(rows, headerIdx, originalFilename) {
  let oznaka = null;
  let projekt = null;
  let opis = null;

  for (let i = 0; i < headerIdx; i++) {
    const r = rows[i] || [];
    if (r[0] === 'Projekt' && projekt === null) projekt = r[2] || null;
    if (r[0] === 'Oznaka (Temeljem)') oznaka = r[2] || null;
    if (r[0] === 'Opis narudžbe (Opis)') opis = r[2] || null;
  }

  if (!oznaka) {
    const m = originalFilename.match(/\d+-\d+_NS_\d+/i);
    oznaka = m ? m[0] : originalFilename.replace(/\.xlsm?$/i, '');
  }
  const nalogBase = String(oznaka).toUpperCase().trim();

  // Stupce tražimo po NAZIVU iz zaglavlja, ne po fiksnoj poziciji - raspored
  // stupaca zna se razlikovati između pojedinih NS naloga.
  const headerRow = rows[headerIdx] || [];
  function colIndex(...candidates) {
    for (let i = 0; i < headerRow.length; i++) {
      const h = headerRow[i];
      if (h == null) continue;
      const norm = String(h).trim().toLowerCase();
      if (candidates.includes(norm)) return i;
    }
    return -1;
  }
  const idxRb = colIndex('rb.', 'rb');
  const idxSifra = colIndex('šifra', 'sifra');
  const idxVarijanta = colIndex('varijanta');
  const idxKolicina = colIndex('kolicina', 'količina');
  const idxJm = colIndex('jm');
  const idxNapomena = colIndex('napomena');
  const idxBarcode = colIndex('barcode');
  const rbCol = idxRb !== -1 ? idxRb : 0; // 'RB.' je uvjet za prepoznavanje ovog formata pa je gotovo uvijek 0

  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const rb = r[rbCol];
    if (rb === null || rb === undefined || rb === '') break; // kraj tablice
    if (typeof rb !== 'number') continue;

    // Ključ 1: onaj koji je stvarno upisan u Barcode stupcu (može imati
    // dodatno slovo/checksum, npr. "23-1039_NS_1900_3B").
    const barcodeRaw = idxBarcode !== -1 && r[idxBarcode] != null ? String(r[idxBarcode]) : '';
    const bm = barcodeRaw.match(/(\d+-\d+_[Nn][Ss]_\d+_[0-9A-Za-z]+)/);
    const scanKeys = [];
    if (bm) scanKeys.push(bm[1].toUpperCase());
    // Ključ 2 (rezervni): jednostavan "{oznaka}_{redni broj}" - neki naloz
    // koriste točno taj oblik bez ikakvog dodatka.
    const naiveKey = nalogBase + '_' + Number(rb);
    if (!scanKeys.includes(naiveKey)) scanKeys.push(naiveKey);

    let finishing = idxNapomena !== -1 && r[idxNapomena] != null ? String(r[idxNapomena]).trim() : '';
    if (finishing === '-/-' || finishing === '-') finishing = '';

    items.push({
      item: Number(rb),
      partNumber: idxSifra !== -1 && r[idxSifra] != null ? String(r[idxSifra]).trim() : '',
      description: idxVarijanta !== -1 && r[idxVarijanta] != null ? String(r[idxVarijanta]).trim() : '',
      finishing,
      ralCode: extractRalCode(finishing),
      colorName: finishing || null,
      colorHex: colorForFinishing(finishing),
      qty: idxKolicina !== -1 && r[idxKolicina] != null ? r[idxKolicina] : null,
      uom: idxJm !== -1 && r[idxJm] != null ? String(r[idxJm]).trim() : '',
      pod: '',
      techSteps: [],
      scanKeys
    });
  }

  return {
    format: 'NS',
    nalogBase,
    nalogPuni: String(oznaka),
    projekt: projekt ? String(projekt).trim() : null,
    opis: opis ? String(opis).trim() : null,
    odjel: null,
    sourceFile: originalFilename,
    uploadedAt: new Date().toISOString(),
    items
  };
}

// Prepozna format datoteke i parsira u zajednički oblik
// { format, nalogBase, nalogPuni, projekt, opis, odjel, sourceFile, uploadedAt, items }
// gdje svaka pozicija (item) nosi "scanKeys" - popis mogućih ključeva pod
// kojima bi se sken te pozicije mogao naći.
function parseNalogWorkbook(buffer, originalFilename) {
  const wb = XLSX.read(buffer, { type: 'buffer' });

  const woSheetName = wb.SheetNames.find(n => n.toLowerCase() === 'workingorder');
  if (woSheetName) {
    return parseRnNalog(wb, woSheetName, originalFilename);
  }

  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const headerIdx = rows.findIndex(r => r && r[0] === 'RB.' && String(r[1] || '').trim() === 'Šifra');
    if (headerIdx !== -1) {
      return parseNsNalog(rows, headerIdx, originalFilename);
    }
  }

  throw new Error(
    'Ne prepoznajem format ove datoteke kao radni nalog (ni "WorkingOrder" ni "NarM" tablicu pozicija) — ' +
    'provjeri je li ovo ispravan radni nalog / narudžba materijala.'
  );
}

// Parsira CSV skenova. Vraća { byKey: {key: {count,scanEvents,lastSeen,workstations}}, skippedRows, totalRows, otherFormats }
// Podržava:
//   RN31194_14        -> RN format, registrira i "RN31194_14" i bazni oblik
//   RN30327_1_10      -> RN format sa "podnalogom", registrira oba oblika
//   23-1039_NS_1900_3B -> NS format, registrira točno taj tekst kao ključ
function parseSkenoviCsv(buffer) {
  const text = buffer.toString('utf8');
  let records;
  try {
    records = csvParse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    });
  } catch (e) {
    throw new Error('Ne mogu pročitati CSV datoteku: ' + e.message);
  }

  const byKey = new Map(); // key -> { count, scanEvents, lastSeen, workstations: Set }
  let skipped = 0;
  const otherFormats = {}; // primjeri redaka koji ne odgovaraju nijednom prepoznatom obrascu

  function bump(key, rec) {
    let entry = byKey.get(key);
    if (!entry) {
      entry = { count: 0, scanEvents: 0, lastSeen: null, workstations: new Set() };
      byKey.set(key, entry);
    }
    // "number_of_pieces" je multiplikator kod skupnog skeniranja (upiše se
    // broj komada pa se jednom klikne na barkod) - zbrajamo stvarni broj
    // komada, ne broj redaka u CSV-u.
    let pieces = Number(rec.number_of_pieces);
    if (!Number.isFinite(pieces) || pieces <= 0) pieces = 1;
    entry.count += pieces;
    entry.scanEvents += 1;
    if (rec.datetime) {
      if (!entry.lastSeen || String(rec.datetime) > entry.lastSeen) entry.lastSeen = String(rec.datetime);
    }
    if (rec.workstation) entry.workstations.add(String(rec.workstation));
  }

  const rnRe = /^(RN\d+(?:_\d+)*)_(\d+)$/i;
  const nsRe = /^(\d+-\d+_NS_\d+)_([0-9A-Za-z]+)$/i;

  for (const rec of records) {
    const scanned = rec.scanned_number;
    if (!scanned) { skipped++; continue; }
    const s = String(scanned).trim();

    const mRn = s.match(rnRe);
    if (mRn) {
      const rawPrefix = mRn[1].toUpperCase();
      const item = Number(mRn[2]);
      const base = extractRnBase(rawPrefix);
      bump(rawPrefix + '_' + item, rec);      // puni oblik, npr. RN30327_1_10
      if (rawPrefix !== base) {
        bump(base + '_' + item, rec);         // bazni oblik, npr. RN30327_10
      }
      continue;
    }

    const mNs = s.match(nsRe);
    if (mNs) {
      bump(s.toUpperCase(), rec); // cijeli tekst je ključ (uklj. eventualno slovo na kraju)
      continue;
    }

    skipped++;
    const shape = s.replace(/\d+/g, '#');
    otherFormats[shape] = (otherFormats[shape] || 0) + 1;
  }

  const result = {};
  for (const [key, e] of byKey.entries()) {
    result[key] = {
      count: e.count,
      scanEvents: e.scanEvents,
      lastSeen: e.lastSeen,
      workstations: Array.from(e.workstations)
    };
  }

  return { byKey: result, skippedRows: skipped, totalRows: records.length, otherFormats };
}

// Spaja parsirane naloge (objekt keyed by nalogBase) i skenove u status po poziciji
function computeStatus(nalozi, skenoviByKey) {
  const result = [];
  for (const nalogBase of Object.keys(nalozi)) {
    const nalog = nalozi[nalogBase];
    const itemsWithStatus = nalog.items.map(it => {
      let sken = null;
      for (const key of (it.scanKeys || [])) {
        if (skenoviByKey[key]) { sken = skenoviByKey[key]; break; }
      }
      const komadaSkenirano = sken ? sken.count : 0;
      const potrebnaKolicina = typeof it.qty === 'number' ? it.qty : null;

      let status; // 'nema' | 'djelomicno' | 'potpuno'
      if (komadaSkenirano <= 0) {
        status = 'nema';
      } else if (potrebnaKolicina !== null && komadaSkenirano < potrebnaKolicina) {
        status = 'djelomicno';
      } else {
        status = 'potpuno';
      }

      return {
        ...it,
        skenirano: status === 'potpuno', // zadržano radi kompatibilnosti (npr. CSV izvoz)
        statusSkeniranja: status,
        komadaSkenirano,
        brojSkeniranja: sken ? sken.scanEvents : 0,
        zadnjiSken: sken ? sken.lastSeen : null,
        stanice: sken ? sken.workstations : []
      };
    });
    const total = itemsWithStatus.length;
    const done = itemsWithStatus.filter(i => i.statusSkeniranja === 'potpuno').length;
    const partial = itemsWithStatus.filter(i => i.statusSkeniranja === 'djelomicno').length;
    result.push({
      nalogBase,
      nalogPuni: nalog.nalogPuni,
      projekt: nalog.projekt,
      opis: nalog.opis,
      odjel: nalog.odjel,
      format: nalog.format,
      sourceFile: nalog.sourceFile,
      uploadedAt: nalog.uploadedAt,
      total,
      done,
      partial,
      missing: total - done,
      percent: total > 0 ? Math.round((done / total) * 1000) / 10 : 0,
      items: itemsWithStatus
    });
  }
  result.sort((a, b) => a.nalogBase.localeCompare(b.nalogBase));
  return result;
}

module.exports = { extractRnBase, parseNalogWorkbook, parseSkenoviCsv, computeStatus };
