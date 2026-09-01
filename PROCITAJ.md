# Praćenje skeniranja pozicija

Samostalna aplikacija (odvojena od server_app / vikend-rasporeda) koja
spaja radne naloge (Excel) i CSV izvoz skenova te pokazuje koje su
pozicije skenirane, a koje nisu — po radnom nalogu, s postotkom
gotovosti i CSV izvozom nedostajućih pozicija.

## Kako radi (logika prepoznavanja)

- Iz Excel radnog naloga (list "WorkingOrder") čita se tablica pozicija
  (stupac "Item" = redni broj pozicije, "Part Number", "Description", "QTY"...)
  i broj naloga (ćelija "Broj radnog naloga", npr. `RN31194_1`).
- Iz CSV-a sa skenovima čita se stupac `scanned_number`. Barkod je oblika
  `RN{broj}_{pozicija}` (npr. `RN31194_14`), a kod nekih starijih naloga
  `RN{broj}_{podnalog}_{pozicija}` (npr. `RN30327_1_10`) — aplikacija
  prepoznaje oba oblika automatski.
- Redci u CSV-u koji ne odgovaraju tom obrascu (npr. drugačiji sustav
  oznaka koji počinje s "24-1096_NS_..." — izgleda da je to posve drugi
  sustav praćenja, ne radni nalozi) se preskaču i broj preskočenih se
  prikazuje uz upload, radi transparentnosti.
- CSV se ažurira punom zamjenom pri svakom uploadu — očekuje se da uvijek
  uploadaš najnoviji **puni** izvoz skenova, a ne samo nove retke.

## Spremanje podataka — Supabase (trajno, umjesto privremenog diska)

Aplikacija sad podatke sprema u Supabase, pa preživljavaju restart i
redeploy Render servisa (više ne treba ponovno uploadati naloge/CSV
nakon svakog redeploya).

### 1. Napravi tablicu u Supabaseu

U svom Supabase projektu: **SQL Editor → New query**, zalijepi sadržaj
datoteke `supabase_setup.sql` (iz ovog projekta) i klikni **Run**.
Ovo napravi jednu jednostavnu tablicu `kv_store` u koju se sprema sve.

### 2. Pronađi svoj URL i Service Role ključ

U Supabase dashboardu: **Project Settings → API**.
- **Project URL** (izgleda kao `https://xxxxx.supabase.co`)
- **service_role key** (u sekciji "Project API keys" — NE "anon public"
  ključ, nego "service_role"; taj ključ ima puni pristup i ne smije
  nikad završiti u frontend kodu ili na GitHubu, samo kao Render
  environment varijabla)

### 3. Postavi ih kao environment varijable na Renderu

Render dashboard → tvoj servis → **Environment** → **Add Environment
Variable**, dodaj:
- `SUPABASE_URL` = tvoj Project URL
- `SUPABASE_SERVICE_KEY` = tvoj service_role ključ

Spremi — Render će sam redeployati servis s novim varijablama.

### Lokalno testiranje sa Supabaseom

Kopiraj `.env.example` u `.env` (u istoj mapi), upiši svoje stvarne
vrijednosti u `.env`, pa pokreni `node server.js`. Datoteka `.env` se
ne smije commitati na GitHub (već je u `.gitignore`).

## 1. Testiranje lokalno (preporučeno prije deploya)

1. Raspakiraj ovaj zip.
2. Otvori Command Prompt (ili portable Node.js kao za vikend-raspored) u
   toj mapi i pokreni:
   ```
   npm install
   node server.js
   ```
3. Otvori `http://localhost:3000` u Chromeu i probaj uploadati jedan
   radni nalog + CSV.

## 2. Postavljanje na GitHub (novi, zaseban repo)

1. Idi na github.com, klikni "New repository" (npr. naziv
   `skeniranje-app`), postavi ga kao **Private** ako želiš, ne dodaji
   README/gitignore (već ih imamo).
2. Otvori GitHub Desktop → File → Add Local Repository → odaberi
   raspakiranu mapu ovog projekta.
3. Ako te pita da inicijalizira git repo, potvrdi (Create a repository).
4. Poveži ga s repozitorijem koji si napravio na GitHubu (Publish
   repository / u Repository postavkama postavi remote).
5. Commit sve datoteke ("Initial commit"), pa Push origin.

## 3. Postavljanje na Render (novi, zaseban servis)

1. Idi na dashboard.render.com → "New +" → "Web Service".
2. Poveži novi GitHub repo (`skeniranje-app`) koji si upravo napravio.
3. Postavke:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free (isto kao vikend-raspored)
4. Klikni "Create Web Service" — Render će sam napraviti prvi deploy
   (par minuta).
5. Kad status postane "Live", dobit ćeš vlastiti URL (nešto poput
   `https://skeniranje-app.onrender.com`) — to je tvoja nova, potpuno
   odvojena aplikacija, dostupna s mobitela/browsera baš kao i
   vikend-raspored, ali ne dijeli s njim ništa (drugi kod, drugi
   repo, drugi Render servis).

## Važna napomena — spremanje podataka

Otkad je aplikacija spojena na Supabase (vidi sekciju gore), podaci se
čuvaju trajno i preživljavaju restart/redeploy Render servisa — više
ne treba ponovno uploadati naloge i CSV nakon svake promjene koda.

## Struktura datoteka

```
skeniranje-app/
  server.js              - pokretanje aplikacije (lokalno i na Renderu)
  routes/skeniranje.js    - API rute (upload, status, CSV izvoz)
  lib/parse.js             - parsiranje Excela i CSV-a, logika spajanja
  lib/store.js              - spremanje/čitanje podataka iz Supabasea
  public/skeniranje.html   - sučelje
  public/skeniranje.js     - JS logika sučelja
  supabase_setup.sql        - SQL za napraviti tablicu u Supabaseu
  .env.example               - predložak za lokalne environment varijable
```

## Kasnija promjena koda

Za svaku sljedeću izmjenu: uredi datoteke u lokalnoj mapi repozitorija,
commit + push kroz GitHub Desktop kao i inače — Render sam pokupi
promjenu i redeploya ovaj servis, neovisno o vikend-rasporedu.
