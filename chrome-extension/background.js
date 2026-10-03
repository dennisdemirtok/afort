// Opens Google Ads → Fakturering → Dokument in a minimized window early each month, lets
// content.js fetch the invoices AFORT does not have yet and uploads them to AFORT.

const SOURCE = "Google Ads";
const DEFAULT_PAGES = ["https://ads.google.com/aw/billing/documents?ocid=8557099085&authuser=dennis@transfercraft.com"];
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
// Google publishes last month's invoice by the fifth working day; after the 15th we stop looking
const LAST_DAY_TO_LOOK = 15;

async function settings() {
  const s = await chrome.storage.local.get(["afortUrl", "token", "pages"]);
  return {
    afortUrl: (s.afortUrl || "").replace(/\/+$/, ""),
    token: s.token || "",
    pages: Array.isArray(s.pages) && s.pages.length ? s.pages : DEFAULT_PAGES,
  };
}

async function afort(path, init = {}) {
  const { afortUrl, token } = await settings();
  if (!afortUrl || !token) throw new Error("Fyll i AFORT-adress och API-nyckel under Alternativ");
  const res = await fetch(`${afortUrl}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `AFORT svarade ${res.status}`);
  return body;
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

async function runPage(pageUrl) {
  const win = await chrome.windows.create({ url: pageUrl, focused: false, state: "minimized" });
  const tabId = win.tabs[0].id;
  await setRunTab(tabId, { pageUrl });
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ errors: ["Dokument-sidan svarade inte – är du inloggad på Google Ads i Chrome?"], uploaded: [] }), RUN_TIMEOUT_MS);
      waiting.set(tabId, (summary) => { clearTimeout(timer); resolve(summary); });
    });
  } finally {
    waiting.delete(tabId);
    await setRunTab(tabId, null);
    chrome.windows.remove(win.id).catch(() => {});
  }
}

let running = null;

async function runAll(reason) {
  if (running) return running;
  running = (async () => {
    const { pages } = await settings();
    const state = (await chrome.storage.local.get("latestIssued")).latestIssued || {};
    const results = [];
    for (const pageUrl of pages) {
      const summary = await runPage(pageUrl);
      if (summary.latestIssued) state[pageUrl] = summary.latestIssued;
      results.push({ pageUrl, ...summary });
    }
    const lastRun = { at: new Date().toISOString(), reason, results };
    await chrome.storage.local.set({ lastRun, latestIssued: state, lastRunDay: today() });
    const uploaded = results.reduce((n, r) => n + (r.uploaded || []).length, 0);
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

/** Once a day during the first half of the month, until last month's invoice has been seen. */
async function scheduledRun() {
  const now = new Date();
  if (now.getDate() > LAST_DAY_TO_LOOK) return;
  const { lastRunDay, latestIssued = {} } = await chrome.storage.local.get(["lastRunDay", "latestIssued"]);
  if (lastRunDay === today()) return;
  const { pages, afortUrl, token } = await settings();
  if (!afortUrl || !token) return;
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
  if (pages.every((p) => (latestIssued[p] || "").slice(0, 7) >= lastMonthKey)) return;
  await runAll("schemalagd");
}

// ---- Messages from content.js and the options page ----------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "frame-ready") {
      const tabs = await runTabs();
      if (!sender.tab || !tabs[sender.tab.id]) return { run: false };
      try {
        const { references } = await afort(`/api/receipt-documents?source=${encodeURIComponent(SOURCE)}`);
        return { run: true, known: references };
      } catch (err) {
        waiting.get(sender.tab.id)?.({ errors: [err.message], uploaded: [] });
        return { run: false };
      }
    }
    if (msg.type === "upload") {
      const bytes = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), `${msg.number}.pdf`);
      form.append("source", SOURCE);
      form.append("reference", msg.number);
      if (msg.issuedAt) form.append("issued_at", msg.issuedAt);
      try {
        const body = await afort("/api/receipt-documents", { method: "POST", body: form });
        return { ok: true, status: body.status };
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
        const { references } = await afort(`/api/receipt-documents?source=${encodeURIComponent(SOURCE)}`);
        return { ok: true, count: references.length };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
  })().then(sendResponse);
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("afort-check", { periodInMinutes: 180, delayInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("afort-check", { periodInMinutes: 180, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "afort-check") scheduledRun().catch((err) => console.error("[AFORT]", err));
});
