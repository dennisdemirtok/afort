// Fetches invoices that are only available behind a login (no PDF by mail, no API for card
// payments) and uploads the ones AFORT is missing. Each portal is opened in a minimized window
// with the session already in Chrome; a content script there lists the documents.
//
// Adding a portal: an entry in PORTALS, a content script for its pages in manifest.json that
// answers "frame-ready" and sends "upload" + "done", and its host permissions.

const PORTALS = {
  "google-ads": {
    label: "Google Ads",
    source: "Google Ads",
    // Google publishes last month's invoice by the fifth working day
    schedule: "monthly",
    defaults: { pages: ["https://ads.google.com/aw/billing/documents?ocid=8557099085&authuser=dennis@transfercraft.com"] },
  },
  anthropic: {
    label: "Anthropic (Claude Console)",
    source: "Anthropic",
    // A new invoice every time credits are bought
    schedule: "daily",
    // Earlier invoices were paid with another card
    defaults: { pages: ["https://platform.claude.com/settings/billing"], fromDate: "2026-09-21" },
  },
};

const RUN_TIMEOUT_MS = 3 * 60 * 1000;
const LAST_DAY_TO_LOOK = 15;

async function settings() {
  const s = await chrome.storage.local.get(["afortUrl", "token", "portals", "pages"]);
  const portals = {};
  for (const [id, portal] of Object.entries(PORTALS)) {
    const saved = (s.portals || {})[id] || {};
    // Version 1 kept the Google Ads pages at the top level
    const legacyPages = id === "google-ads" && Array.isArray(s.pages) && s.pages.length ? s.pages : null;
    portals[id] = {
      enabled: saved.enabled !== false,
      pages: Array.isArray(saved.pages) && saved.pages.length ? saved.pages : legacyPages || portal.defaults.pages,
      fromDate: saved.fromDate || portal.defaults.fromDate || null,
    };
  }
  return { afortUrl: (s.afortUrl || "").replace(/\/+$/, ""), token: s.token || "", portals };
}

async function afort(path, init = {}) {
  const { afortUrl, token } = await settings();
  if (!afortUrl || !token) throw new Error("Fyll i AFORT-adress och API-nyckel under Alternativ");
  const res = await fetch(`${afortUrl}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `AFORT svarade ${res.status}`);
  return body;
}

async function uploadPdf(portalId, { number, issuedAt, base64, url }) {
  let blob;
  if (base64) {
    blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "application/pdf" });
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`PDF:en kunde inte hämtas (${res.status})`);
    blob = await res.blob();
  }
  const head = new TextDecoder().decode(new Uint8Array(await blob.slice(0, 5).arrayBuffer()));
  if (head !== "%PDF-") throw new Error("Ingen PDF");
  const form = new FormData();
  form.append("file", new Blob([blob], { type: "application/pdf" }), `${number}.pdf`);
  form.append("source", PORTALS[portalId].source);
  form.append("reference", number);
  if (issuedAt) form.append("issued_at", issuedAt);
  const body = await afort("/api/receipt-documents", { method: "POST", body: form });
  return body.status;
}

// ---- Runs ----------------------------------------------------------------

// Tabs opened by a run; kept in session storage so a restarted service worker still knows them
async function runTabs() {
  return (await chrome.storage.session.get("runTabs")).runTabs || {};
}
async function setRunTab(tabId, value) {
  const tabs = await runTabs();
  if (value) tabs[tabId] = value; else delete tabs[tabId];
  await chrome.storage.session.set({ runTabs: tabs });
}

const waiting = new Map(); // tabId → resolve(summary)

async function runPage(portalId, pageUrl) {
  const win = await chrome.windows.create({ url: pageUrl, focused: false, state: "minimized" });
  const tabId = win.tabs[0].id;
  await setRunTab(tabId, { portalId, pageUrl });
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ errors: [`Sidan svarade inte – är du inloggad på ${PORTALS[portalId].label} i Chrome?`], uploaded: [] }), RUN_TIMEOUT_MS);
      waiting.set(tabId, (summary) => { clearTimeout(timer); resolve(summary); });
    });
  } finally {
    waiting.delete(tabId);
    await setRunTab(tabId, null);
    chrome.windows.remove(win.id).catch(() => {});
  }
}

let running = null;

async function runAll(reason, only) {
  if (running) return running;
  running = (async () => {
    const { portals } = await settings();
    const state = (await chrome.storage.local.get("latestIssued")).latestIssued || {};
    const results = [];
    for (const [portalId, config] of Object.entries(portals)) {
      if (!config.enabled || (only && !only.includes(portalId))) continue;
      for (const pageUrl of config.pages) {
        const summary = await runPage(portalId, pageUrl);
        if (summary.latestIssued) state[pageUrl] = summary.latestIssued;
        results.push({ portal: PORTALS[portalId].label, pageUrl, ...summary });
      }
    }
    const lastRun = { at: new Date().toISOString(), reason, results };
    await chrome.storage.local.set({ lastRun, latestIssued: state });
    const uploaded = results.reduce((n, r) => n + (r.uploaded || []).filter((u) => u.status === "created" || u.status === "attached").length, 0);
    const failed = results.some((r) => (r.errors || []).length);
    chrome.action.setBadgeBackgroundColor({ color: failed ? "#b91c1c" : "#15803d" });
    chrome.action.setBadgeText({ text: failed ? "!" : uploaded ? String(uploaded) : "" });
    return lastRun;
  })();
  try { return await running; } finally { running = null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Which portals are due: daily ones once a day; monthly ones during the first half of the month until last month's invoice is seen. */
async function scheduledRun() {
  const { afortUrl, token, portals } = await settings();
  if (!afortUrl || !token) return;
  const { lastRunDays = {}, latestIssued = {} } = await chrome.storage.local.get(["lastRunDays", "latestIssued"]);
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;

  const due = Object.entries(portals).filter(([id, config]) => {
    if (!config.enabled || lastRunDays[id] === today()) return false;
    if (PORTALS[id].schedule === "daily") return true;
    if (now.getDate() > LAST_DAY_TO_LOOK) return false;
    return config.pages.some((p) => (latestIssued[p] || "").slice(0, 7) < lastMonthKey);
  }).map(([id]) => id);
  if (due.length === 0) return;

  for (const id of due) lastRunDays[id] = today();
  await chrome.storage.local.set({ lastRunDays });
  await runAll("schemalagd", due);
}

// ---- Messages from the content scripts and the options page -------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const run = sender.tab ? (await runTabs())[sender.tab.id] : null;
    if (msg.type === "frame-ready") {
      // Pages the user opens are left alone
      if (!run || (msg.portal && msg.portal !== run.portalId)) return { run: false };
      try {
        const { references } = await afort(`/api/receipt-documents?source=${encodeURIComponent(PORTALS[run.portalId].source)}`);
        const { portals } = await settings();
        return { run: true, known: references, fromDate: portals[run.portalId].fromDate };
      } catch (err) {
        waiting.get(sender.tab.id)?.({ errors: [err.message], uploaded: [] });
        return { run: false };
      }
    }
    if (msg.type === "upload") {
      if (!run) return { ok: false, error: "Ingen körning pågår" };
      try {
        return { ok: true, status: await uploadPdf(run.portalId, msg) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (msg.type === "done") {
      if (sender.tab) waiting.get(sender.tab.id)?.(msg.summary);
      return { ok: true };
    }
    if (msg.type === "run-now") return runAll("manuell");
    if (msg.type === "test-connection") {
      try {
        const counts = [];
        for (const portal of Object.values(PORTALS)) {
          const { references } = await afort(`/api/receipt-documents?source=${encodeURIComponent(portal.source)}`);
          counts.push(`${references.length} från ${portal.label}`);
        }
        return { ok: true, message: `AFORT har ${counts.join(", ")}.` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (msg.type === "settings") return { portals: PORTALS, settings: await settings() };
  })().then(sendResponse);
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

function schedule() {
  chrome.alarms.create("afort-check", { periodInMinutes: 180, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "afort-check") scheduledRun().catch((err) => console.error("[AFORT]", err));
});
