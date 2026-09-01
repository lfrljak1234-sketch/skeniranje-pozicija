const XLSX = require('xlsx');
const { parse: csvParse } = require('csv-parse/sync');

// Izvuci "bazu" broja naloga iz stringa poput "RN31194_1" -> "RN31194"
// (radni nalog u ćeliji ima sufiks _1, _2..., ali skenovi barkodiraju
// pozicije direktno kao RN{broj}_{item}, bez tog dodatnog sufiksa)
function extractNalogBase(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  const m = s.match(/^(RN\d+)/i);
  return m ? m[1].toUpperCase() : s.toUpperCase();
}

// Parsira jedan .xlsx/.xlsm radni nalog -> { nalogBase, nalogPuni, projekt, opis, odjel, sourceFile, items: [...] }
function parseNalogWorkbook(buffer, originalFilename) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'workingorder') || wb.SheetNames[0];
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
    // fallback: pokušaj izvući iz naziva datoteke, npr. "...RN31194_1_.xlsm"
    const m = originalFilename.match(/RN\d+(_\d+)?/i);
    nalogPuni = m ? m[0] : originalFilename;
  }
  if (headerIdx === -1) {
    throw new Error(`Ne mogu pronaći tablicu pozicija (red "Item / Part Number") u listu "${sheetName}" — provjeri je li ovo ispravan radni nalog.`);
  }

  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const item = r[0];
    if (item === null || item === undefined || item === '') break; // kraj tablice
    if (typeof item !== 'number') continue;
    items.push({
      item: Number(item),
      partNumber: r[1] != null ? String(r[1]).trim() : '',
      description: r[2] != null ? String(r[2]).trim() : '',
      qty: r[5] != null ? r[5] : null,
      uom: r[6] != null ? String(r[6]).trim() : '',
      pod: r[7] != null ? String(r[7]).trim() : ''
    });
  }

  return {
    nalogBase: extractNalogBase(nalogPuni),
    nalogPuni: String(nalogPuni),
    projekt: projekt ? String(projekt).trim() : null,
    opis: opis ? String(opis).trim() : null,
    odjel: odjel ? String(odjel).trim() : null,
    sourceFile: originalFilename,
    uploadedAt: new Date().toISOString(),
    items
  };
}

// Parsira CSV skenova. Vraća { byKey: {key: {count,lastSeen,workstations}}, skippedRows, totalRows, otherFormats }
// Podržava dva formata barkoda koja se pojavljuju u podacima:
//   RN31194_14        -> nalogBase="RN31194", item=14
//   RN30327_1_10      -> "podnalog" RN30327_1, item=10 (stariji/alternativni format)
// Za svaki sken registriramo OBA moguća ključa (bazni i puni), pa se poklapa
// s onim što god radni nalog stvarno koristi kao svoj broj.
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

  const byKey = new Map(); // key -> { count, lastSeen, workstations: Set }
  let skipped = 0;
  const otherFormats = {}; // primjeri redaka koji ne odgovaraju RN.._... obrascu (za dijagnostiku)

  function bump(key, rec) {
    let entry = byKey.get(key);
    if (!entry) {
      entry = { count: 0, lastSeen: null, workstations: new Set() };
      byKey.set(key, entry);
    }
    entry.count += 1;
    if (rec.datetime) {
      if (!entry.lastSeen || String(rec.datetime) > entry.lastSeen) entry.lastSeen = String(rec.datetime);
    }
    if (rec.workstation) entry.workstations.add(String(rec.workstation));
  }

  for (const rec of records) {
    const scanned = rec.scanned_number;
    if (!scanned) { skipped++; continue; }
    const s = String(scanned).trim();
    // group1 = sve prije zadnjeg "_", group2 = zadnji broj (pretpostavljena pozicija)
    const m = s.match(/^(RN\d+(?:_\d+)*)_(\d+)$/i);
    if (!m) {
      skipped++;
      const shape = s.replace(/\d+/g, '#');
      otherFormats[shape] = (otherFormats[shape] || 0) + 1;
      continue;
    }
    const rawPrefix = m[1].toUpperCase();
    const item = Number(m[2]);
    const base = extractNalogBase(rawPrefix);

    bump(rawPrefix + '_' + item, rec);      // puni oblik, npr. RN30327_1_10
    if (rawPrefix !== base) {
      bump(base + '_' + item, rec);         // bazni oblik, npr. RN30327_10
    }
  }

  const result = {};
  for (const [key, e] of byKey.entries()) {
    result[key] = { count: e.count, lastSeen: e.lastSeen, workstations: Array.from(e.workstations) };
  }

  return { byKey: result, skippedRows: skipped, totalRows: records.length, otherFormats };
}

// Spaja parsirane naloge (objekt keyed by nalogBase) i skenove (flat array) u status po poziciji
function computeStatus(nalozi, skenoviByKey) {
  const result = [];
  for (const nalogBase of Object.keys(nalozi)) {
    const nalog = nalozi[nalogBase];
    const nalogPuniNorm = String(nalog.nalogPuni).toUpperCase().trim();
    const itemsWithStatus = nalog.items.map(it => {
      const keyBase = nalogBase + '_' + it.item;
      const keyPuni = nalogPuniNorm + '_' + it.item;
      const sken = skenoviByKey[keyBase] || skenoviByKey[keyPuni];
      return {
        ...it,
        skenirano: !!sken,
        brojSkeniranja: sken ? sken.count : 0,
        zadnjiSken: sken ? sken.lastSeen : null,
        stanice: sken ? sken.workstations : []
      };
    });
    const total = itemsWithStatus.length;
    const done = itemsWithStatus.filter(i => i.skenirano).length;
    result.push({
      nalogBase,
      nalogPuni: nalog.nalogPuni,
      projekt: nalog.projekt,
      opis: nalog.opis,
      odjel: nalog.odjel,
      sourceFile: nalog.sourceFile,
      uploadedAt: nalog.uploadedAt,
      total,
      done,
      missing: total - done,
      percent: total > 0 ? Math.round((done / total) * 1000) / 10 : 0,
      items: itemsWithStatus
    });
  }
  result.sort((a, b) => a.nalogBase.localeCompare(b.nalogBase));
  return result;
}

module.exports = { extractNalogBase, parseNalogWorkbook, parseSkenoviCsv, computeStatus };
