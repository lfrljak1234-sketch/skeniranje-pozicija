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

async function fetchBoardCards() {
  const url = `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/cards?` +
    `checklists=all&checklist_fields=name&fields=name,labels,closed&` +
    `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Trello API greška ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Vraća Map: opis (naziv kartice, trim+lowercase) -> { cardName, machine, labels, itemsByPartNumber }
async function getCardsByOpis(forceRefresh) {
  if (!isConfigured()) return null;
  const now = Date.now();
  if (!forceRefresh && cache.cardsByOpis && (now - cache.at) < CACHE_MS) {
    return cache.cardsByOpis;
  }

  const cards = await fetchBoardCards();
  const map = new Map();

  for (const card of cards) {
    if (card.closed) continue;
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

    map.set(String(card.name).trim().toLowerCase(), {
      cardName: card.name,
      machine: machineLabel,
      labels,
      itemsByPartNumber
    });
  }

  cache = { at: now, cardsByOpis: map };
  return map;
}

// Obogati status naloga (izlaz iz computeStatus) CNC podacima iz Trella.
// Izvuci moguće ključeve za usporedbu s nazivom Trello kartice.
// "Opis RNa" polje zna sadržavati čisti kod (npr. "1096-1-ELE-A7E-01") ILI
// kod s dodatnim opisom (npr. "1096-1-ELE-A7E-01 - 82 CNC"), dok Trello
// kartica obično ima samo čisti kod - pokušavamo oboje.
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

// Obogati status naloga (izlaz iz computeStatus) CNC podacima iz Trella.
// Ne baca grešku ako Trello nije konfiguriran ili dohvat ne uspije - u tom
// slučaju samo ne dodaje cnc polja (aplikacija radi dalje bez te informacije).
async function enrichWithTrello(statusList, forceRefresh) {
  if (!isConfigured()) {
    return { statusList, trelloInfo: { configured: false } };
  }
  try {
    const cardsByOpis = await getCardsByOpis(forceRefresh);
    for (const nalog of statusList) {
      let card = null;
      for (const key of opisMatchKeys(nalog.opis)) {
        card = cardsByOpis.get(key);
        if (card) break;
      }
      nalog.trelloCard = card ? { cardName: card.cardName, machine: card.machine, labels: card.labels } : null;
      for (const it of nalog.items) {
        const entry = card ? card.itemsByPartNumber.get(String(it.partNumber).toUpperCase()) : null;
        it.cncGotovo = entry ? entry.checked : null; // null = nema podatka (nema kartice/stavke)
        it.cncStroj = card ? card.machine : null;
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
