const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn(
    'UPOZORENJE: SUPABASE_URL i/ili SUPABASE_SERVICE_KEY nisu postavljeni. ' +
    'Aplikacija neće moći spremati/čitati podatke dok ih ne postaviš (vidi PROCITAJ.md).'
  );
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const TABLE = 'kv_store';

// Učitaj vrijednost pod danim ključem. Vraća fallback ako ključ ne postoji.
async function loadJson(key, fallback) {
  if (!supabase) return fallback;
  const { data, error } = await supabase
    .from(TABLE)
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.error(`Greška pri čitanju "${key}" iz Supabase:`, error.message);
    return fallback;
  }
  return data ? data.value : fallback;
}

// Spremi vrijednost pod danim ključem (upsert - stvara ili ažurira redak).
async function saveJson(key, value) {
  if (!supabase) {
    throw new Error('Supabase nije konfiguriran (nedostaje SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  }
  const { error } = await supabase
    .from(TABLE)
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) {
    throw new Error(`Greška pri spremanju "${key}" u Supabase: ${error.message}`);
  }
}

// Obriši jedan redak po ključu.
async function deleteKey(key) {
  if (!supabase) {
    throw new Error('Supabase nije konfiguriran (nedostaje SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  }
  const { error } = await supabase.from(TABLE).delete().eq('key', key);
  if (error) {
    throw new Error(`Greška pri brisanju "${key}" u Supabase: ${error.message}`);
  }
}

// Učitaj SVE retke čiji ključ počinje danim prefiksom (npr. "nalog:").
// Vraća objekt { keySuffix: value }, gdje je keySuffix dio ključa nakon
// prefiksa. Stranicira upite (Supabase zna vraćati max 1000 redaka po
// upitu) kako bi radilo i s desecima tisuća naloga.
async function loadAllByPrefix(prefix) {
  if (!supabase) return {};
  const result = {};
  const PAGE_SIZE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('key, value')
      .like('key', prefix + '%')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error(`Greška pri čitanju redaka s prefiksom "${prefix}" iz Supabase:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data) {
      result[row.key.slice(prefix.length)] = row.value;
    }
    if (data.length < PAGE_SIZE) break; // zadnja stranica
    from += PAGE_SIZE;
  }
  return result;
}

// Obriši SVE retke čiji ključ počinje danim prefiksom.
async function deleteAllByPrefix(prefix) {
  if (!supabase) {
    throw new Error('Supabase nije konfiguriran (nedostaje SUPABASE_URL / SUPABASE_SERVICE_KEY).');
  }
  const { error } = await supabase.from(TABLE).delete().like('key', prefix + '%');
  if (error) {
    throw new Error(`Greška pri brisanju redaka s prefiksom "${prefix}" u Supabase: ${error.message}`);
  }
}

module.exports = { loadJson, saveJson, deleteKey, loadAllByPrefix, deleteAllByPrefix };
