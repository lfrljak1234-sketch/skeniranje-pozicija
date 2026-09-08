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

// --- ASL "Production Plan (PS)" list - dodatni pregled po Part Numberu ---
// koji se koristi za provjeru je li pozicija gotova kroz VEĆ uploadane RN
// naloge istog projekta (zbraja skenirane komade po Part Numberu preko
// svih RN naloga s istim projektnim kodom u opisu).
function parseProductionPlan(wb, sheetName) {
  if (!wb.SheetNames.includes(sheetName)) return null;
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  const headerIdx = rows.findIndex(r => r && (r[1] === 'Part_Number' || r[1] === 'Article_Number'));
  if (headerIdx === -1) return null;
  const header = rows[headerIdx];
  const pnCol = header.findIndex(h => h === 'Part_Number' || h === 'Article_Number');
  const descCol = header.findIndex(h => h === 'Description');
  const totalCol = header.findIndex(h => h === 'TOTAL');
  if (pnCol === -1 || totalCol === -1) return null;

  const entries = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const pn = r[pnCol];
    if (pn === null || pn === undefined || String(pn).trim() === '') continue;
    const total = r[totalCol];
    entries.push({
      partNumber: String(pn).trim(),
      description: descCol !== -1 && r[descCol] != null ? String(r[descCol]).trim() : '',
      total: typeof total === 'number' ? total : null
    });
  }
  return entries.length ? entries : null;
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
    productionPlan: parseProductionPlan(wb, 'ProductionPlan (PS)'),
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

// Ključ za poklapanje "opis" polja između RN i NS dokumenata (isti obrazac
// kao za Trello - "opis" zna imati dodatak odjela, npr. "... - 81 SSP").
function opisMatchKey(opis) {
  if (!opis) return null;
  const full = String(opis).trim();
  return full.split(/\s+-\s+/)[0].trim().toLowerCase();
}

// Pozicije čiji naziv/šifra sadrži jednu od "dvofaznih" oznaka (npr. "fin",
// "soffit") imaju DVIJE faze skeniranja istog komada: PRIJE obrade
// (plastifikacija sirovog profila, skenira se u NS/narudžba materijala
// dokumentu) i NAKON obrade (plastifikacija gotovog komada, skenira se pod
// RN pozicijom). Pozicija je potpuno gotova tek kad su OBJE faze gotove.
// Popis oznaka je uredljiv u aplikaciji (spremljen u Supabase) - ovo je
// samo zadana vrijednost ako ništa nije spremljeno.
const DEFAULT_DUALPHASE_KEYWORDS = ['fin', 'soffit'];

function buildDualPhaseRegex(keywords) {
  const list = (keywords && keywords.length ? keywords : DEFAULT_DUALPHASE_KEYWORDS)
    .map(k => String(k).trim()).filter(Boolean);
  if (list.length === 0) return null;
  const escaped = list.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i');
}

function statusOd(komada, potrebno) {
  if (komada <= 0) return 'nema';
  if (potrebno !== null && komada < potrebno) return 'djelomicno';
  return 'potpuno';
}

// Dvofazno skeniranje (prije/nakon obrade) ima smisla samo za CNC naloge -
// "obrada" tu znači CNC obradu koja razdvaja prije/poslije. U SSP nalozima
// se sve plastificira nakon (jednofazno), pa fin/soffit pozicije tamo
// tretiramo kao obične pozicije.
function isCncDept(odjel) {
  return odjel ? /cnc/i.test(String(odjel)) : false;
}

// Spaja parsirane naloge (objekt keyed by nalogBase) i skenove u status po poziciji
function computeStatus(nalozi, skenoviByKey, dualPhaseKeywords, preOnlyKeywords) {
  const dualPhaseRe = buildDualPhaseRegex(dualPhaseKeywords);
  const preOnlyRe = preOnlyKeywords && preOnlyKeywords.length ? buildDualPhaseRegex(preOnlyKeywords) : null;
  // Indeks NS naloga po njihovom "opisu" (za fin/soffit i "samo prije" povezivanje)
  const nsByOpis = new Map();
  for (const key of Object.keys(nalozi)) {
    const n = nalozi[key];
    if (n.format !== 'NS') continue;
    const k = opisMatchKey(n.opis);
    if (!k) continue;
    if (!nsByOpis.has(k)) nsByOpis.set(k, []);
    nsByOpis.get(k).push(n);
  }

  function findPreSken(linkedNsNalozi, partNumber) {
    for (const nsNalog of linkedNsNalozi) {
      const match = nsNalog.items.find(nsIt =>
        nsIt.partNumber && String(nsIt.partNumber).toUpperCase() === String(partNumber).toUpperCase()
      );
      if (!match) continue;
      for (const key of (match.scanKeys || [])) {
        if (skenoviByKey[key]) return skenoviByKey[key];
      }
    }
    return null;
  }

  // --- Prolaz 1: izračunaj status pozicija za svaki nalog ---
  const itemsByNalog = new Map(); // nalogBase -> itemsWithStatus[]
  for (const nalogBase of Object.keys(nalozi)) {
    const nalog = nalozi[nalogBase];
    const linkedNsNalozi = nalog.format === 'RN'
      ? (nsByOpis.get(opisMatchKey(nalog.opis)) || [])
      : [];

    const itemsWithStatus = nalog.items.map(it => {
      const potrebnaKolicina = typeof it.qty === 'number' ? it.qty : null;
      const nazivZaProvjeru = (it.partNumber || '') + ' ' + (it.description || '');
      const isFinSoffit = !!(it.partNumber && dualPhaseRe && dualPhaseRe.test(nazivZaProvjeru));
      const isPreOnly = !!(it.partNumber && preOnlyRe && preOnlyRe.test(nazivZaProvjeru));
      const primjenjivo = linkedNsNalozi.length > 0 && isCncDept(nalog.odjel);

      // Faza "nakon obrade" - preko RN-ovog vlastitog ključa pozicije
      let skenPost = null;
      for (const key of (it.scanKeys || [])) {
        if (skenoviByKey[key]) { skenPost = skenoviByKey[key]; break; }
      }
      const postKomada = skenPost ? skenPost.count : 0;

      // --- Pozicija koja treba SAMO sken prije obrade (preko NS-a) ---
      if (isPreOnly && !isFinSoffit && primjenjivo) {
        const skenPre = findPreSken(linkedNsNalozi, it.partNumber);
        const preKomada = skenPre ? skenPre.count : 0;
        const status = statusOd(preKomada, potrebnaKolicina);
        return {
          ...it,
          skenirano: status === 'potpuno',
          statusSkeniranja: status,
          komadaSkenirano: preKomada,
          brojSkeniranja: skenPre ? skenPre.scanEvents : 0,
          zadnjiSken: skenPre ? skenPre.lastSeen : null,
          stanice: skenPre ? skenPre.workstations : [],
          faze: null
        };
      }

      if (!isFinSoffit || !primjenjivo) {
        // Standardna pozicija (ili fin/soffit bez povezanog NS naloga) -
        // ponašanje kao i do sad, jedna faza skeniranja (preko RN-a).
        const status = statusOd(postKomada, potrebnaKolicina);
        return {
          ...it,
          skenirano: status === 'potpuno',
          statusSkeniranja: status,
          komadaSkenirano: postKomada,
          brojSkeniranja: skenPost ? skenPost.scanEvents : 0,
          zadnjiSken: skenPost ? skenPost.lastSeen : null,
          stanice: skenPost ? skenPost.workstations : [],
          faze: null
        };
      }

      // Fin/soffit pozicija s povezanim NS nalogom - faza "prije obrade"
      const skenPre = findPreSken(linkedNsNalozi, it.partNumber);
      const preKomada = skenPre ? skenPre.count : 0;

      const preStatus = statusOd(preKomada, potrebnaKolicina);
      const postStatus = statusOd(postKomada, potrebnaKolicina);
      // Potpuno gotovo SAMO ako su obje faze potpune; inače djelomično ako
      // je barem nešto od toga dvoje krenulo, inače nema.
      let status;
      if (preStatus === 'potpuno' && postStatus === 'potpuno') status = 'potpuno';
      else if (preKomada > 0 || postKomada > 0) status = 'djelomicno';
      else status = 'nema';

      // "Uska grla" broj komada - koliko je stvarno kompletno prošlo obje faze
      const komadaSkenirano = Math.min(preKomada, postKomada);

      return {
        ...it,
        skenirano: status === 'potpuno',
        statusSkeniranja: status,
        komadaSkenirano,
        brojSkeniranja: (skenPre ? skenPre.scanEvents : 0) + (skenPost ? skenPost.scanEvents : 0),
        zadnjiSken: [skenPre && skenPre.lastSeen, skenPost && skenPost.lastSeen].filter(Boolean).sort().pop() || null,
        stanice: [...new Set([...(skenPre ? skenPre.workstations : []), ...(skenPost ? skenPost.workstations : [])])],
        faze: {
          prijeObrade: { komada: preKomada, status: preStatus },
          nakonObrade: { komada: postKomada, status: postStatus }
        }
      };
    });
    itemsByNalog.set(nalogBase, itemsWithStatus);
  }

  // --- Prolaz 2: sastavi konačni rezultat (bez plana - dodaje se kasnije,
  // nakon Trello obogaćivanja, preko applyProductionPlanStatus) ---
  const result = [];
  for (const nalogBase of Object.keys(nalozi)) {
    const nalog = nalozi[nalogBase];
    const itemsWithStatus = itemsByNalog.get(nalogBase) || [];

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
      items: itemsWithStatus,
      productionPlan: nalog.productionPlan || null,
      productionPlanStatus: null
    });
  }
  result.sort((a, b) => a.nalogBase.localeCompare(b.nalogBase));
  return result;
}

// Nadogradi rezultat computeStatus() s ASL "Production Plan" usporedbom -
// poziva se NAKON Trello obogaćivanja (enrichWithTrello), jer koristi CNC
// podatke koji se dodaju tek tada. Zbraja preko SVIH RN naloga istog
// projekta (po "opis" polju): broj skeniranih komada, CNC status (samo za
// CNC odjel naloge - cncGotovo je već null za sve ostale, po postojećem
// pravilu), i korake proizvodnje (samo za SSP odjel naloge - techSteps je
// već prazan za sve ostale, po postojećem pravilu).
function applyProductionPlanStatus(statusList) {
  const aggByProjectPart = new Map(); // "projektKey|PARTNUMBER" -> agregat

  for (const nalog of statusList) {
    if (nalog.format !== 'RN') continue;
    const projectKey = opisMatchKey(nalog.opis);
    if (!projectKey) continue;
    for (const it of nalog.items) {
      if (!it.partNumber) continue;
      const key = projectKey + '|' + it.partNumber.toUpperCase();
      let agg = aggByProjectPart.get(key);
      if (!agg) {
        agg = { skenirano: 0, cncGotovo: null, cncStroj: null, techSteps: [] };
        aggByProjectPart.set(key, agg);
      }
      agg.skenirano += (it.komadaSkenirano || 0);
      if (it.cncGotovo === true) {
        agg.cncGotovo = true;
        agg.cncStroj = it.cncStroj || agg.cncStroj;
      } else if (it.cncGotovo === false && agg.cncGotovo !== true) {
        agg.cncGotovo = false;
        agg.cncStroj = it.cncStroj || agg.cncStroj;
      }
      if (it.techSteps && it.techSteps.length) {
        for (const s of it.techSteps) {
          const existing = agg.techSteps.find(x => x.naziv === s.naziv);
          if (existing) {
            existing.gotovoKolicina = Math.max(existing.gotovoKolicina || 0, s.gotovoKolicina || 0);
          } else {
            agg.techSteps.push({ ...s });
          }
        }
      }
    }
  }

  for (const nalog of statusList) {
    if (!nalog.productionPlan) continue;
    const projectKey = opisMatchKey(nalog.opis);
    nalog.productionPlanStatus = nalog.productionPlan.map(pe => {
      const key = projectKey + '|' + pe.partNumber.toUpperCase();
      const agg = aggByProjectPart.get(key) || { skenirano: 0, cncGotovo: null, cncStroj: null, techSteps: [] };
      const status = statusOd(agg.skenirano, pe.total);
      return {
        ...pe,
        skenirano: agg.skenirano,
        status,
        cncGotovo: agg.cncGotovo,
        cncStroj: agg.cncStroj,
        techSteps: agg.techSteps
      };
    });
  }
  return statusList;
}

module.exports = { extractRnBase, parseNalogWorkbook, parseSkenoviCsv, computeStatus, applyProductionPlanStatus, DEFAULT_DUALPHASE_KEYWORDS, opisMatchKey };
