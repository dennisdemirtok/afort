// Claude Console (platform.claude.com → Settings → Billing → Invoice history). The page only
// loads its data while visible, so the invoices are read from the same API the page uses,
// with the signed-in session. Each invoice has a public Stripe PDF link that the background
// worker downloads and uploads to AFORT. Only acts in windows the extension opened itself.
(async () => {
  const start = await chrome.runtime.sendMessage({ type: "frame-ready", portal: "anthropic" });
  if (!start || !start.run) return;

  const summary = { found: 0, uploaded: [], skipped: 0, latestIssued: null, errors: [] };
  try {
    const known = new Set(start.known || []);
    const orgs = await getJson("/api/organizations");
    let billed = 0;
    let lastError = null;
    for (const org of orgs) {
      let invoices;
      try {
        // The API accepts at most 99
        invoices = (await getJson(`/api/organizations/${org.uuid}/invoices?limit=99`)).invoices || [];
        billed++;
      } catch (err) {
        lastError = err.message;
        continue; // claude.ai organizations have no API billing (403)
      }
      for (const inv of invoices) {
        const issued = (inv.effective_at || "").slice(0, 10);
        // Usage invoices of $0 and unpaid ones are not receipts
        if (!inv.invoice_number || !inv.download_url || !inv.amount || inv.invoice_status !== "paid") continue;
        if (start.fromDate && issued < start.fromDate) continue;
        summary.found++;
        if (!summary.latestIssued || issued > summary.latestIssued) summary.latestIssued = issued;
        if (known.has(inv.invoice_number)) { summary.skipped++; continue; }
        const result = await chrome.runtime.sendMessage({ type: "upload", number: inv.invoice_number, issuedAt: issued, url: inv.download_url });
        if (result && result.ok) summary.uploaded.push({ number: inv.invoice_number, status: result.status });
        else summary.errors.push(`${inv.invoice_number}: ${result && result.error ? result.error : "AFORT svarade inte"}`);
      }
    }
    if (billed === 0) summary.errors.push(`Hittade ingen organisation med fakturor (${lastError || "inga organisationer"}) – är du inloggad i Claude Console?`);
  } catch (err) {
    summary.errors.push(err.message);
  }
  chrome.runtime.sendMessage({ type: "done", summary });

  async function getJson(path) {
    const res = await fetch(path, { credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(`Claude Console svarade ${res.status}${body && body.error && body.error.message ? `: ${body.error.message}` : ""}`);
    }
    return res.json();
  }
})();
