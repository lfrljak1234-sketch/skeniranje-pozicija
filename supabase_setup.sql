-- Pokreni ovo u Supabase dashboardu: tvoj projekt -> SQL Editor -> New query -> Run

create table if not exists kv_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Ova aplikacija pristupa tablici preko "service role" ključa sa servera
-- (ne preko browsera), pa RLS (Row Level Security) ovdje ne treba biti
-- uključen za ovu tablicu - service role ključ ionako zaobilazi RLS.
-- Ako Supabase po defaultu uključi RLS na novoj tablici, ništa se ne
-- pokvari (service role ga zaobilazi), ali za svaki slučaj:
alter table kv_store disable row level security;
