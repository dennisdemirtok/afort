const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { attached: "kopplad till kvittot", created: "nytt kvitto", deleted: "raderad i AFORT, hoppades över", exists: "fanns redan" };

function show(message, kind) {
  $("status").textContent = message;
  $("status").className = kind || "";
}

async function load() {
  const { settings } = await chrome.runtime.sendMessage({ type: "settings" });
  $("afortUrl").value = settings.afortUrl || "";
  $("token").value = settings.token || "";
  $("google-ads-enabled").checked = settings.portals["google-ads"].enabled;
  $("google-ads-pages").value = settings.portals["google-ads"].pages.join("\n");
  $("anthropic-enabled").checked = settings.portals.anthropic.enabled;
  $("anthropic-from").value = settings.portals.anthropic.fromDate || "";
  renderLastRun((await chrome.storage.local.get("lastRun")).lastRun);
}

function renderLastRun(lastRun) {
  if (!lastRun) return;
  const body = $("lastBody");
  body.textContent = `${new Date(lastRun.at).toLocaleString("sv-SE")} (${lastRun.reason})`;
  const list = document.createElement("ul");
  for (const r of lastRun.results || []) {
    const li = document.createElement("li");
    const uploaded = (r.uploaded || []).map((u) => `${u.number} (${STATUS_TEXT[u.status] || u.status})`);
    const parts = [];
    if (uploaded.length) parts.push(`uppladdade: ${uploaded.join(", ")}`);
    else if (!(r.errors || []).length) parts.push(`inga nya fakturor (${r.found || 0} i listan)`);
    if ((r.errors || []).length) parts.push(`fel: ${r.errors.join("; ")}`);
    li.textContent = `${r.portal || "Google Ads"}: ${parts.join(" · ")}`;
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
  const pages = $("google-ads-pages").value.split("\n").map((p) => p.trim()).filter(Boolean);
  if (pages.some((p) => !p.startsWith("https://ads.google.com/"))) return show("Google Ads-sidorna ska vara adresser på ads.google.com", "err");
  // The extension may only talk to the AFORT server the user chose
  const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
  if (!granted) return show("Chrome gav inte tillåtelse att nå AFORT-servern.", "err");
  await chrome.storage.local.set({
    afortUrl: url.origin,
    token: $("token").value.trim(),
    portals: {
      "google-ads": { enabled: $("google-ads-enabled").checked, pages },
      anthropic: { enabled: $("anthropic-enabled").checked, fromDate: $("anthropic-from").value || null },
    },
  });
  await chrome.storage.local.remove("pages");
  show("Sparat.", "ok");
}

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  show("Testar…");
  const res = await chrome.runtime.sendMessage({ type: "test-connection" });
  if (res && res.ok) show(`Anslutningen fungerar. ${res.message}`, "ok");
  else show(res ? res.error : "Inget svar", "err");
});

$("run").addEventListener("click", async () => {
  $("run").disabled = true;
  show("Hämtar fakturor … (öppnar minimerade fönster, tar upp till ett par minuter)");
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
