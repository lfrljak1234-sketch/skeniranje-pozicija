const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID;

function isConfigured() {
  return !!(TRELLO_API_KEY && TRELLO_TOKEN && TRELLO_BOARD_ID);
}

// Kratkotrajni cache (30s) da se izbjegne dohvaćanje Trella pri svakom
// pojedinačnom prikazu ako se stranica brzo osvježava/otvara više puta -
// i dalje je "live" u praksi (max 30s star podatak).
const CACHE_MS = 30 * 1000;
let cache = { at: 0, cardsByOpis: null };

// Naljepnica koja izgleda kao naziv CNC stroja, npr. "SBZ140-1"
// (slova pa brojevi - razlikuje se od npr. "BFR" koje nema brojeva).
const MACHINE_LABEL_RE = /^[A-Z]{2,6}\d/i;

function parseChecklistItemText(text) {
  // Stavke checkliste izgledaju kao "1096-1-PR009-1-101-001    96"
  // (part number, razmak/tab, količina)
  const m = String(text).trim().match(/^(\S+)\s+(\d+)\s*$/);
  if (m) return { partNumber: m[1], qty: Number(m[2]) };
  return { partNumber: String(text).trim(), qty: null };
}

// "/all" u putanji uključuje i arhivirane (closed) kartice - te znaju
// sadržavati stvarno gotove pozicije (npr. lista "CNC: Completed").
async function fetchBoardCards() {
  const url = `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards/all?` +
    `checklists=all&checklist_fields=name&fields=name,labels,closed&` +
    `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Trello API greška ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Izvuci moguće ključeve za usporedbu s nazivom Trello kartice.
// "Opis RNa" polje zna sadržavati čisti kod (npr. "1096-1-ELE-A7E-01") ILI
// kod s dodatnim opisom odjela (npr. "1096-1-ELE-A7E-01 - 82 CNC"), dok
// Trello kartica obično ima samo čisti kod - pokušavamo oboje.
function opisMatchKeys(opis) {
  if (!opis) return [];
  const full = String(opis).trim();
  const keys = [full.toLowerCase()];
  const beforeDash = full.split(/\s+-\s+/)[0].trim();
  if (beforeDash && beforeDash.toLowerCase() !== full.toLowerCase()) {
    keys.push(beforeDash.toLowerCase());
  }
  return keys;
}

// Odjel se zna nalaziti kao sufiks u opisu, npr. "... - 82 CNC" ili
// "... - 81 SSP". Isti projektni kod znaju dijeliti nalozi iz RAZLIČITIH
// odjela (SSP i CNC), pa provjeru radimo SAMO za CNC naloge - inače bismo
// pogrešno uparili SSP nalog s CNC karticama istog projekta.
function isLikelyCncDept(opis) {
  if (!opis) return true; // nema podatka o odjelu - ne blokiramo, pokušaj upariti
  const parts = String(opis).trim().split(/\s+-\s+/);
  if (parts.length < 2) return true; // nema sufiksa odjela - ne blokiramo
  const dept = parts[parts.length - 1].trim();
  return /cnc/i.test(dept);
}

// Vraća Map: naziv kartice (trim+lowercase) -> ARRAY kartica s tim nazivom
// (isti naziv zna postojati na više kartica - serija se dijelila po
// strojevima/serijama, pa svaka kartica pokriva samo dio pozicija).
async function getCardsByOpis(forceRefresh) {
  if (!isConfigured()) return null;
  const now = Date.now();
  if (!forceRefresh && cache.cardsByOpis && (now - cache.at) < CACHE_MS) {
    return cache.cardsByOpis;
  }

  const cards = await fetchBoardCards();
  const map = new Map();

  for (const card of cards) {
    const labels = (card.labels || []).map(l => l.name).filter(Boolean);
    const machineLabel = labels.find(name => MACHINE_LABEL_RE.test(name)) || null;

    const itemsByPartNumber = new Map();
    for (const checklist of (card.checklists || [])) {
      for (const ci of (checklist.checkItems || [])) {
        const { partNumber, qty } = parseChecklistItemText(ci.name);
        if (!partNumber) continue;
        itemsByPartNumber.set(partNumber.toUpperCase(), {
          checked: ci.state === 'complete',
          qty
        });
      }
    }

    const entry = {
      cardName: card.name,
      machine: machineLabel,
      labels,
      closed: !!card.closed,
      itemsByPartNumber
    };
    const key = String(card.name).trim().toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }

  cache = { at: now, cardsByOpis: map };
  return map;
}

// Obogati status naloga (izlaz iz computeStatus) CNC podacima iz Trella.
// Spaja podatke sa SVIH kartica istog naziva - za svaku poziciju posebno
// traži je li označena na BILO KOJOJ od tih kartica (gotovo pobjeđuje ako
// je gotovo na barem jednoj), i pamti na kojem je stroju to učinjeno.
// Ne baca grešku ako Trello nije konfiguriran ili dohvat ne uspije - u tom
// slučaju samo ne dodaje cnc polja (aplikacija radi dalje bez te informacije).
async function enrichWithTrello(statusList, forceRefresh) {
  if (!isConfigured()) {
    return { statusList, trelloInfo: { configured: false } };
  }
  try {
    const cardsByOpis = await getCardsByOpis(forceRefresh);
    for (const nalog of statusList) {
      if (!isLikelyCncDept(nalog.opis)) {
        // Nije CNC odjel (npr. SSP) - ne pokušavamo uparivanje uopće, čak i
        // ako postoji kartica s istim projektnim kodom (pripada drugom nalogu).
        nalog.trelloCard = null;
        for (const it of nalog.items) { it.cncGotovo = null; it.cncStroj = null; }
        continue;
      }

      let matchingCards = [];
      for (const key of opisMatchKeys(nalog.opis)) {
        const found = cardsByOpis.get(key);
        if (found && found.length) { matchingCards = found; break; }
      }

      if (matchingCards.length) {
        const machines = [...new Set(matchingCards.map(c => c.machine).filter(Boolean))];
        nalog.trelloCard = {
          cardName: matchingCards[0].cardName,
          matchedCards: matchingCards.length,
          machines
        };
      } else {
        nalog.trelloCard = null;
      }

      for (const it of nalog.items) {
        const pn = String(it.partNumber).toUpperCase();
        let checkedEntry = null;   // prva kartica gdje je pozicija OZNAČENA
        let uncheckedEntry = null; // prva kartica gdje postoji ali NIJE označena
        for (const c of matchingCards) {
          const e = c.itemsByPartNumber.get(pn);
          if (!e) continue;
          if (e.checked && !checkedEntry) checkedEntry = { ...e, machine: c.machine };
          if (!e.checked && !uncheckedEntry) uncheckedEntry = { ...e, machine: c.machine };
        }
        const winner = checkedEntry || uncheckedEntry;
        it.cncGotovo = winner ? winner.checked : null; // null = nema podatka ni na jednoj kartici
        it.cncStroj = winner ? winner.machine : null;
      }
    }
    return { statusList, trelloInfo: { configured: true, ok: true, cachedAt: cache.at } };
  } catch (e) {
    console.error('Greška pri dohvaćanju Trella:', e.message);
    for (const nalog of statusList) {
      nalog.trelloCard = null;
      for (const it of nalog.items) { it.cncGotovo = null; it.cncStroj = null; }
    }
    return { statusList, trelloInfo: { configured: true, ok: false, error: e.message } };
  }
}

module.exports = { isConfigured, enrichWithTrello };
