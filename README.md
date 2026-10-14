# UNMADE. — gestionale di produzione

Gestionale interno della produzione UNMADE.: progetti, giorni di shooting, call sheet, calendario, team e parco attrezzatura (camere, lenti, accessori) con blocco dei conflitti di disponibilità.

- Sito: pubblicato con GitHub Pages
- Dati e accessi: Supabase (login con utente e password, aggiornamenti in tempo reale)

Nessun dato e nessuna password sono salvati in questo repository.

## Struttura

- `index.html` — l'app (interfaccia, logica, pagina di accesso)
- `js/backend.js` — collegamento a Supabase: dati in tempo reale, immagini private, accesso
- `js/config.js` — indirizzo del progetto Supabase e chiave pubblica
- `vendor/supabase.js` — libreria ufficiale Supabase (v2.117.3)
- `supabase/schema.sql` — struttura del database e regole di sicurezza, da eseguire una volta nel SQL Editor di Supabase
- `manifest.webmanifest`, `icons/` — installazione come app sul telefono

## Ruoli

- `admin` — tutto, compresa la modifica di ruoli e username
- `editor` — crea e modifica progetti, team, attrezzatura, eventi e immagini
- `viewer` — sola consultazione
