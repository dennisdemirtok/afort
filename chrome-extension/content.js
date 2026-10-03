// Bridge between page.js (in Google's page) and the extension's background worker. It only acts
// in windows the extension opened itself; a page the user opens is left alone.
(async () => {
  const CHANNEL = "afort-google-ads";
  let nextId = 1;

  function askPage(action, extra = {}, timeoutMs = 60000) {
    const id = `${Date.now()}-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", onMessage); reject(new Error(`Sidan svarade inte (${action})`)); }, timeoutMs);
      function onMessage(event) {
        const msg = event.data;
        if (event.source !== window || !msg || msg.channel !== CHANNEL || msg.dir !== "to-content" || msg.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        msg.ok ? resolve(msg.result) : reject(new Error(msg.error));
      }
      window.addEventListener("message", onMessage);
      window.postMessage({ channel: CHANNEL, dir: "to-page", id, action, ...extra }, location.origin);
    });
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  const start = await chrome.runtime.sendMessage({ type: "frame-ready", portal: "google-ads" });
  if (!start || !start.run) return;

  const summary = { found: 0, uploaded: [], skipped: 0, latestIssued: null, errors: [] };
  try {
    await askPage("ping", {}, 5000);
    const documents = await askPage("list");
    summary.found = documents.length;
    const known = new Set(start.known || []);
    for (const doc of documents) {
      const issued = parseDate(doc.date);
      if (issued && (!summary.latestIssued || issued > summary.latestIssued)) summary.latestIssued = issued;
      if (known.has(doc.number)) { summary.skipped++; continue; }
      try {
        const { data } = await askPage("fetch", { number: doc.number });
        const result = await chrome.runtime.sendMessage({ type: "upload", number: doc.number, issuedAt: issued, base64: toBase64(data) });
        if (!result || !result.ok) throw new Error(result && result.error ? result.error : "AFORT svarade inte");
        summary.uploaded.push({ number: doc.number, status: result.status, amount: doc.amount });
      } catch (err) {
        summary.errors.push(`${doc.number}: ${err.message}`);
      }
    }
  } catch (err) {
    summary.errors.push(err.message);
  }
  chrome.runtime.sendMessage({ type: "done", summary });

  /** "30 september 2026", "30 sep. 2026", "Sep 30, 2026" → "2026-09-30" */
  function parseDate(text) {
    const months = ["jan", "feb", "mar", "apr", "ma", "jun", "jul", "aug", "sep", "okt|oct", "nov", "dec"];
    const t = text.toLowerCase();
    const year = (t.match(/\b(20\d\d)\b/) || [])[1];
    const day = (t.match(/\b(\d{1,2})\b(?!\d)/) || [])[1];
    const month = months.findIndex((m) => new RegExp(`\\b(?:${m === "ma" ? "maj|may" : m})`).test(t));
    if (!year || !day || month < 0) return null;
    return `${year}-${String(month + 1).padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
})();
