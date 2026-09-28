# AFORT – Faktura-automat

Hämtar leverantörsfakturor från Gmail, tolkar PDF:erna, håller koll på vad som är betalt och skapar
betalfiler (ISO 20022 pain.001) för Nordea.

## Så fungerar det

- **Gmail** kontrolleras var 15:e minut (och vid start). Mail från avsändarna under *Inställningar →
  Avsändare som hämtas in* med en bifogad PDF blir fakturor. Hämtningen bygger inte på att mailet är
  oläst – de senaste 30 dagarna gås igenom och redan kända mail hoppas över.
- **Fakturanummer** tas i första hand från ämnesraden (`src/services/invoice-extract.ts`), övrigt från
  PDF:en (`src/services/pdf-parser.ts`).
- **Påminnelser och vidarebefordrade kopior** av en faktura som redan finns blir inte nya fakturor;
  de ger i stället en notis: röd om fakturan är obetald hos oss, gul varning om den är markerad
  betald men leverantören ändå påminner (betalningen kan ha gått till fel konto). Ett betalningskrav
  utan fakturanummer i ämnesraden ("Wezwanie do zapłaty") ger en notis som pekar till mailet.
- **Bankkonto** läses ur PDF:en (IBAN, även polska kontonummer) och kontrollsiffran verifieras. Får en
  leverantör ett annat konto än på sin förra faktura visas en gul varning innan man betalar.
- **Raderade fakturor** kommer aldrig tillbaka, inte heller vid *Läs om alla fakturor*.
- **Läs om alla fakturor** (Inställningar → Underhåll) tolkar om alla mail i bakgrunden men rör inte
  status, betalmarkeringar eller fakturor som ändrats för hand.
- **Bankutdrag**: ladda upp Nordeas CSV, granska träffarna och bocka av betalda fakturor.

## Roller

| Roll | Kan |
|------|-----|
| Administratör | Allt, inklusive radera fakturor, användare, avsändare och underhåll |
| Bokförare | Se fakturor, ladda ner PDF/ZIP/CSV, ändra status, läsa in bankutdrag, skapa betalfiler |

Det inbyggda kontot `admin@afort.local` har `AUTH_TOKEN` som startlösenord. `AUTH_TOKEN` fungerar
alltid som reservnyckel för det kontot (om lösenordet tappas bort) och som `Authorization: Bearer`
för API:et.

## Utveckling

```bash
cp .env.example .env      # fyll i värden
npm install
npm run dev               # bygger CSS och startar med hot reload på http://localhost:3000
npm run typecheck
```

Stilar: Tailwind byggs till en statisk fil (`npm run build:css`) från `src/styles/app.css` och
klasserna i `src/views`. Återkommande komponenter (`.btn`, `.card`, `.input`, `.badge` …) finns i
`src/styles/app.css`. Ikoner: `<span class="icon">namn</span>` (Material Symbols) – ikonfonten
begränsas automatiskt till de ikoner som används i vyerna.

## Drift (Railway)

- Bygg: `npm install && npm run build`, start: `node dist/index.js` (en enda tjänst – Gmail-hämtningen
  körs i samma process).
- Persistent volym monterad på `/data`; sätt `DATABASE_PATH=/data/invoice.db`. Databas, PDF:er och
  betalfiler ligger där.
- Miljövariabler: se `.env.example`. `DEBTOR_IBAN` och `ORG_NUMBER` krävs för giltiga betalfiler.
- Gmail kopplas under *Inställningar → Gmail-koppling*; spara den refresh token som visas som
  `GMAIL_REFRESH_TOKEN`.

Avsändarreglerna ligger i databasen. `src/config/gmail-rules.json` används bara för att fylla en tom
databas första gången.
