const DEFAULT_PAGES = ["https://ads.google.com/aw/billing/documents?ocid=8557099085&authuser=dennis@transfercraft.com"];
const $ = (id) => document.getElementById(id);

function show(message, kind) {
  $("status").textContent = message;
  $("status").className = kind || "";
}

async function load() {
  const s = await chrome.storage.local.get(["afortUrl", "token", "pages", "lastRun"]);
  $("afortUrl").value = s.afortUrl || "";
  $("token").value = s.token || "";
  $("pages").value = (Array.isArray(s.pages) && s.pages.length ? s.pages : DEFAULT_PAGES).join("\n");
  renderLastRun(s.lastRun);
}

function renderLastRun(lastRun) {
  if (!lastRun) return;
  const body = $("lastBody");
  body.textContent = `${new Date(lastRun.at).toLocaleString("sv-SE")} (${lastRun.reason})`;
  const list = document.createElement("ul");
  for (const r of lastRun.results || []) {
    const li = document.createElement("li");
    const uploaded = (r.uploaded || []).map((u) => `${u.number} (${({ attached: "kopplad till mailet", created: "nytt kvitto", deleted: "raderad i AFORT, hoppades över" })[u.status] || "fanns redan"})`);
    const parts = [];
    if (uploaded.length) parts.push(`uppladdade: ${uploaded.join(", ")}`);
    else if (!(r.errors || []).length) parts.push(`inga nya fakturor (${r.found || 0} i listan)`);
    if ((r.errors || []).length) parts.push(`fel: ${r.errors.join("; ")}`);
    li.textContent = parts.join(" · ");
    li.className = (r.errors || []).length ? "err" : "ok";
    list.appendChild(li);
  }
  body.appendChild(list);
}

async function save() {
  let url;
  try {
    url = new URL($("afortUrl").value.trim());
  } catch {
    return show("Ange AFORT-adressen, t.ex. https://afort-production.up.railway.app", "err");
  }
  const pages = $("pages").value.split("\n").map((p) => p.trim()).filter(Boolean);
  if (pages.some((p) => !p.startsWith("https://ads.google.com/"))) return show("Dokument-sidorna ska vara adresser på ads.google.com", "err");
  // The extension may only talk to the AFORT server the user chose
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) return show("Chrome gav inte tillåtelse att nå AFORT-servern.", "err");
  await chrome.storage.local.set({ afortUrl: url.origin, token: $("token").value.trim(), pages });
  show("Sparat.", "ok");
}

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  show("Testar…");
  const res = await chrome.runtime.sendMessage({ type: "test-connection" });
  if (res && res.ok) show(`Anslutningen fungerar. AFORT har ${res.count} Google Ads-fakturor som PDF.`, "ok");
  else show(res ? res.error : "Inget svar", "err");
});

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  show("Hämtar fakturor från Google Ads … (öppnar ett minimerat fönster, tar upp till en minut)");
  try {
    const lastRun = await chrome.runtime.sendMessage({ type: "run-now" });
    const failed = (lastRun.results || []).some((r) => (r.errors || []).length);
    show(failed ? "Klart, men med fel – se nedan." : "Klart.", failed ? "err" : "ok");
    $("lastBody").textContent = "";
    renderLastRun(lastRun);
  } finally {
    $("run").disabled = false;
  }
});

load();
