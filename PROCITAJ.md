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

## Važna napomena — Render free plan

Isto kao kod vikend-rasporeda: disk na Render free planu je privremen.
Kod restarta ili redeploya servisa, uploadani radni nalozi i skenovi
(spremljeni u `data/nalozi.json` i `data/skenovi.json`) se gube. Nakon
svakog restarta/redeploya trebat ćeš ponovno uploadati radne naloge i
zadnji CSV izvoz skenova. Ako ovo postane gnjavaža, rješenje je prelazak
na plaćeni Render plan s trajnim diskom — javi se ako želiš da to
sredimo.

## Struktura datoteka

```
skeniranje-app/
  server.js              - pokretanje aplikacije (lokalno i na Renderu)
  routes/skeniranje.js    - API rute (upload, status, CSV izvoz)
  lib/parse.js             - parsiranje Excela i CSV-a, logika spajanja
  public/skeniranje.html   - sučelje
  public/skeniranje.js     - JS logika sučelja
  data/                    - tu se spremaju uploadani podaci (JSON)
```

## Kasnija promjena koda

Za svaku sljedeću izmjenu: uredi datoteke u lokalnoj mapi repozitorija,
commit + push kroz GitHub Desktop kao i inače — Render sam pokupi
promjenu i redeploya ovaj servis, neovisno o vikend-rasporedu.
