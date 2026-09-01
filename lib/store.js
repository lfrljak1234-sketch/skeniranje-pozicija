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

module.exports = { loadJson, saveJson };
