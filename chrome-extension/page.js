// Runs inside Google's document center (payments.google.com, the table under Google Ads →
// Fakturering → Dokument). It reads the table and fetches a document's PDF with the signed-in
// session. "Hämta" opens a one-time link with window.open; while we fetch, that link is taken
// instead of opened, so nothing is saved to the Downloads folder.
(() => {
  const CHANNEL = "afort-google-ads";
  const realOpen = window.open;
  let capture = null;

  window.open = function (url, ...rest) {
    if (capture && String(url).includes("/apis-secure/doc/")) {
      capture(new URL(String(url), location.href).href);
      return null;
    }
    return realOpen.call(this, url, ...rest);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function dataRows() {
    return [...document.querySelectorAll("tr.b3-widget-table-data-row, table tbody tr[role=row]")]
      .filter((tr) => downloadButton(tr));
  }

  function downloadButton(tr) {
    return [...tr.querySelectorAll("a[role=button], button, [role=button]")].find((el) => /^(Hämta|Download|Ladda ned)$/i.test(el.textContent.trim()));
  }

  /** Cell positions from the header ("Datum för utfärdande", "Dokumenttyp", "Dokumentnummer"). */
  function columns(table, cellCount) {
    const headers = [...table.querySelectorAll("thead th, [role=columnheader]")]
      .map((th) => th.textContent.trim().toLowerCase())
      .filter(Boolean);
    // Rows start with a checkbox cell that has no header text
    const offset = Math.max(0, cellCount - headers.length);
    const find = (re, fallback) => {
      const i = headers.findIndex((h) => re.test(h));
      return i >= 0 ? i + offset : fallback;
    };
    return {
      date: find(/datum|date/, 1),
      type: find(/typ|type/, 2),
      number: find(/nummer|number/, 3),
      amount: find(/belopp|amount/, 4),
    };
  }

  async function listDocuments() {
    for (let i = 0; i < 60 && dataRows().length === 0; i++) {
      if (/inga dokument|no documents/i.test(document.body.innerText)) return [];
      await sleep(500);
    }
    return dataRows().map((tr) => {
      const cells = [...tr.children].map((td) => td.textContent.trim());
      const col = columns(tr.closest("table"), cells.length);
      return { date: cells[col.date] || "", type: cells[col.type] || "", number: (cells[col.number] || "").replace(/\s+/g, ""), amount: cells[col.amount] || "" };
    }).filter((d) => /^[\w/.-]{3,40}$/.test(d.number));
  }

  async function fetchDocument(number) {
    const row = dataRows().find((tr) => [...tr.children].some((td) => td.textContent.replace(/\s+/g, "") === number));
    if (!row) throw new Error(`Dokument ${number} finns inte i tabellen`);
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { capture = null; reject(new Error("Google öppnade ingen nedladdningslänk")); }, 15000);
      capture = (u) => { clearTimeout(timer); capture = null; resolve(u); };
      downloadButton(row).click();
    });
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Google svarade ${res.status}`);
    const data = await res.arrayBuffer();
    if (new TextDecoder().decode(new Uint8Array(data, 0, 5)) !== "%PDF-") throw new Error("Google skickade ingen PDF");
    return { data };
  }

  window.addEventListener("message", async (event) => {
    const msg = event.data;
    if (event.source !== window || !msg || msg.channel !== CHANNEL || msg.dir !== "to-page") return;
    const reply = (body, transfer = []) => window.postMessage({ channel: CHANNEL, dir: "to-content", id: msg.id, ...body }, location.origin, transfer);
    try {
      if (msg.action === "ping") return reply({ ok: true, result: "pong" });
      if (msg.action === "list") return reply({ ok: true, result: await listDocuments() });
      if (msg.action === "fetch") {
        const result = await fetchDocument(msg.number);
        return reply({ ok: true, result }, [result.data]);
      }
      reply({ ok: false, error: `Okänd åtgärd ${msg.action}` });
    } catch (err) {
      reply({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  });
})();
