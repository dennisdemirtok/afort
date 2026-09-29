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
- **Pro forma** från Feelgood hämtas inte (slutfakturan FD … kommer efter leverans). Numret sparas så att
  en bankbetalning som anger pro forma-numret ändå matchas mot slutfakturan.
- **Kvitton** (fliken *Kvitton*): kortköp från Distribold, Google och Meta hämtas från samma Gmail.
  Finns en PDF sparas den, annars sparas själva mailet. Belopp och referens tolkas så gott det går och
  kan rättas för hand; bokföraren markerar kvittot som bokfört. Avsändare styrs under *Inställningar →
  Kvitton som hämtas in*.
- **Shopify** (fliken *Shopify*): utbetalningar från Shopify Payments hämtas via Admin API. Appen *AFORT*
  i Shopifys Dev Dashboard (organisation Transfercraft) är installerad i butiken med
  `read_shopify_payments_payouts` + `read_shopify_payments_accounts`. Sätt `SHOPIFY_STORE_DOMAIN`
  (`viwrsi-jk.myshopify.com`), `SHOPIFY_CLIENT_ID` och `SHOPIFY_CLIENT_SECRET`; AFORT hämtar en ny
  24-timmarstoken med client credentials när den behövs. Varje utbetalning får en CSV med alla ordrar,
  återbetalningar och avgifter plus en sammanställning. Hämtas varje morgon och på knapptryck.
- **Bankutdrag**: ladda upp Nordeas CSV, granska träffarna och bocka av betalda fakturor. Inbetalningar
  som stämmer med en Shopify-utbetalning (belopp, några dagar efter) bockas av på samma sätt.

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
- Persistent volym monterad på `/data`; sätt `DATABASE_PATH=/data/invoice.db`. Databas, PDF:er,
  kvitton, Shopify-underlag och betalfiler ligger där.
- PDF:er visas med PDF.js (kopieras från `pdfjs-dist` till `public/vendor/pdfjs` vid bygge).
- Miljövariabler: se `.env.example`. `DEBTOR_IBAN` och `ORG_NUMBER` krävs för giltiga betalfiler.
- Gmail kopplas under *Inställningar → Gmail-koppling*; spara den refresh token som visas som
  `GMAIL_REFRESH_TOKEN`.

Avsändarreglerna ligger i databasen. `src/config/gmail-rules.json` används bara för att fylla en tom
databas första gången.
