# AFORT – Faktura-automat

Automated invoice processing: Gmail → PDF parsing → Nordea pain.001 payment files.

## Features

- **Gmail polling** – Automatically fetches invoice emails matching configurable rules
- **PDF parsing** – Extracts amount, due date, OCR, bankgiro from invoice PDFs
- **Payment files** – Generates Nordea-compatible ISO 20022 pain.001 XML
- **Web UI** – Invoice management dashboard for the bookkeeper
- **CSV export** – Fortnox-compatible export

## Setup

```bash
cp .env.example .env
# Fill in your Gmail OAuth2 credentials and company details
npm install
npm run build
npm start
```

### Gmail OAuth2

1. Create OAuth2 credentials in Google Cloud Console
2. Visit `/auth/google` to complete the auth flow
3. Save the refresh token as `GMAIL_REFRESH_TOKEN`

## Development

```bash
npm run dev          # Web server with hot reload
npm run dev:worker   # Gmail polling worker
```

## Deployment (Railway)

1. Push to GitHub
2. Connect repo in Railway
3. Add environment variables from `.env.example`
4. Attach persistent volume at `/data`
5. Optionally add a second service for the worker using `node dist/worker.js`

## Environment Variables

See `.env.example` for all required variables.
