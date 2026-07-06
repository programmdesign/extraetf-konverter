"use strict";
/* ============================================================================
   UI layer: file handling, converter dispatch (see js/converters/*), rendering.
   Runs entirely client-side; converter modules register themselves in core.js.
   ============================================================================ */

(function () {
if(typeof document === "undefined") return;   // allow loading in node for tests

const X = globalThis.ExtraETF;
const { fmt, sortKey, toCSV, HEADER } = X;

/* ----------------------------- app state ----------------------------- */
const store = { files: [] };   // {name, text, conv: converterId|null, kind}
let RESULT = null;

/* ============================ conversion & merging ============================ */
function refresh(){
  $("err").textContent = "";
  const byConv = new Map();
  for(const f of store.files){
    if(!f.conv) continue;
    if(!byConv.has(f.conv)) byConv.set(f.conv, []);
    byConv.get(f.conv).push(f);
  }
  const merged = { rows: [], positions: {}, cashSummary: {}, cashOrder: [],
                   banners: [], notes: [], stats: [], banks: [] };
  for(const [id, files] of byConv){
    const conv = X.converters.find(c => c.id === id);
    try{
      const r = conv.convert(files);
      merged.rows.push(...r.rows);
      Object.assign(merged.positions, r.positions);
      for(const k in (r.cashSummary || {})){
        const t = merged.cashSummary[k] || (merged.cashSummary[k] = { ccy: {} });
        for(const c in r.cashSummary[k].ccy) t.ccy[c] = (t.ccy[c] || 0) + r.cashSummary[k].ccy[c];
      }
      merged.cashOrder.push(...(r.cashOrder || []));
      merged.banners.push(...(r.banners || []));
      merged.notes.push(...(r.notes || []));
      merged.stats.push(...(r.stats || []));
      merged.banks.push(conv.label);
    }catch(e){
      console.error(e);
      $("err").textContent = `${conv.label}-Datei(en) konnten nicht verarbeitet werden.`;
    }
  }
  if(merged.banks.length > 1) merged.banners.unshift({ kind: "warn", parts: [
    { b: "Mehrere Banken erkannt" },
    ` (${merged.banks.join(", ")}). ExtraETF importiert je Depot – konvertiere die Banken besser getrennt und importiere jede CSV in das passende Portfolio.`] });
  merged.rows.sort((a,b)=>{ const ka = sortKey(a), kb = sortKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  RESULT = store.files.length ? merged : null;
  render();
}

/* ============================ UI rendering ============================ */
const $ = id => document.getElementById(id);
const pillCls = typ => "pill " + ("" + typ).replace(/[^A-Za-z]/g, "");

/* DOM-Builder: Markup lebt in <template>s, Daten kommen per textContent rein (keine HTML-Strings, kein XSS). */
const tpl    = id => document.getElementById(id).content.firstElementChild.cloneNode(true);
const cell   = (c, forceNum) => {
  const td = document.createElement("td");
  const isObj = c != null && typeof c === "object";
  if(forceNum || (isObj && c.num)) td.className = "num";
  td.textContent = isObj ? c.t : (c == null ? "" : c);
  return td;
};
const rowOf  = cells => { const tr = document.createElement("tr"); for(const c of cells) tr.appendChild(c); return tr; };
const headOf = cols => { const tr = document.createElement("tr"); for(const c of cols){ const th = document.createElement("th"); if(c && c.num){ th.className = "num"; th.textContent = c.t; } else th.textContent = c; tr.appendChild(th); } return tr; };
const bold   = text => { const b = document.createElement("b"); b.textContent = text; return b; };
/** {kind, parts:[string|{b}]} → banner element */
const banner = data => {
  const b = tpl("t-banner"); b.classList.add(data.kind);
  b.append(...data.parts.map(p => (p && typeof p === "object") ? bold(p.b) : p));
  return b;
};

function kindLabel(f){
  if(!f.conv) return "?";
  const conv = X.converters.find(c => c.id === f.conv);
  return (conv && conv.kindLabels && conv.kindLabels[f.kind]) || (conv && conv.label) || "?";
}

function renderFiles(){
  $("fileList").replaceChildren(...store.files.map((f, i) => {
    const li = tpl("t-file");
    const badge = li.querySelector(".badge");
    badge.textContent = kindLabel(f); badge.classList.add(f.conv ? f.kind : "unknown");
    const fn = li.querySelector(".fname"); fn.textContent = f.name; fn.title = f.name;
    li.querySelector(".rm").dataset.i = i;
    return li;
  }));
}

function render(){
  renderFiles();
  if(!RESULT){ $("results").classList.add("hidden"); return; }
  $("results").classList.remove("hidden");
  const { rows, positions, cashSummary, cashOrder, banners, notes, stats, banks } = RESULT;
  const count = tx => rows.filter(r => r.tx === tx).length;
  const openPos = Object.values(positions).filter(p => Math.abs(p.qty) > 1e-6).length;

  /* summary stat cards */
  const cards = [
    ["Transaktionen", rows.length], ["Käufe", count("Kauf")], ["Verkäufe", count("Verkauf")],
    ["Dividenden", count("Dividende")], ["Offene Positionen", openPos], ...stats
  ];
  $("summary").replaceChildren(...cards.map(([l, n]) => {
    const c = tpl("t-stat"); c.querySelector(".n").textContent = n; c.querySelector(".l").textContent = l; return c;
  }));

  /* converter banners (reconcile status, WKN warning, …) */
  $("reconcile").replaceChildren(...banners.map(banner));

  /* preview table */
  $("preview").querySelector("thead").replaceChildren(headOf(HEADER));
  $("preview").querySelector("tbody").replaceChildren(...rows.map(r => {
    const tr = tpl("t-prow"); if(r._bal) tr.classList.add("bal");
    const c = tr.children;
    c[0].textContent = r.d; c[1].textContent = r.isin; c[2].textContent = r.name;
    const pill = c[3].querySelector(".pill"); pill.textContent = r.typ; pill.className = pillCls(r.typ);
    c[4].textContent = r.tx; c[5].textContent = r.preis; c[6].textContent = r.anzahl;
    c[7].textContent = r.geb; c[8].textContent = r.st; c[9].textContent = r.ccy; c[10].textContent = r.wk;
    return tr;
  }));
  $("rowcount").textContent = `· ${rows.length} Zeilen`;

  /* positions table */
  const pos = Object.entries(positions).filter(([,p]) => Math.abs(p.qty) > 1e-6)
    .sort((a,b) => a[1].name.localeCompare(b[1].name));
  $("positions").querySelector("thead").replaceChildren(headOf(["ISIN/WKN", "Name", "Typ", { t: "Netto-Stück", num: true }]));
  $("positions").querySelector("tbody").replaceChildren(...pos.map(([isin, p]) => {
    const tr = tpl("t-posrow"); const c = tr.children;
    c[0].textContent = isin; c[1].textContent = p.name;
    const pill = c[2].querySelector(".pill"); pill.textContent = p.typ; pill.className = pillCls(p.typ);
    c[3].textContent = fmt(p.qty);
    return tr;
  }));

  /* notes: converter-provided tables / inline banners */
  const noteEls = notes.map(n => {
    if(n.banner) return banner(n.banner);
    const d = tpl("t-note");
    const s = d.querySelector("summary"); s.textContent = n.title + " ";
    const cnt = document.createElement("span"); cnt.className = "cnt"; cnt.textContent = n.rows.length; s.appendChild(cnt);
    d.querySelector("thead").replaceChildren(headOf(n.cols));
    d.querySelector("tbody").replaceChildren(...n.rows.map(cells => rowOf(cells.map(c => cell(c)))));
    return d;
  });
  if(noteEls.length){
    const head = document.createElement("div");
    head.className = "step-head"; head.style.marginTop = "22px"; head.textContent = "Hinweise";
    $("flags").replaceChildren(head, ...noteEls);
  } else $("flags").replaceChildren();

  /* cash summary (manual bookings) */
  const keys = Object.keys(cashSummary).sort((a,b) => {
    const ia = cashOrder.indexOf(a), ib = cashOrder.indexOf(b);
    return ((ia < 0 ? 99 : ia)) - ((ib < 0 ? 99 : ib));
  });
  const box = $("cashbox"); box.replaceChildren(tpl("t-cash-intro"));
  if(keys.length){
    const wrap = document.createElement("div"); wrap.className = "tablewrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead"); thead.appendChild(headOf(["Buchungsart", "Beträge je Währung"]));
    const tbody = document.createElement("tbody");
    for(const k of keys){
      const parts = Object.entries(cashSummary[k].ccy).map(([c, v]) => `${fmt(Math.round(v*100)/100)} ${c}`).join(" · ");
      tbody.appendChild(rowOf([cell(k), cell({ t: parts, num: true })]));
    }
    table.append(thead, tbody); wrap.appendChild(table); box.appendChild(wrap);
  } else {
    const p = document.createElement("p"); p.className = "muted"; p.textContent = "Keine Cash-Buchungen gefunden.";
    box.appendChild(p);
  }

  $("downloadBtn").disabled = rows.length === 0;
  $("rowInfo").textContent = rows.length ? `· ${rows.length} Zeilen` : "";
}

/* ============================ file handling & events ============================ */
/** Decode CSV bytes: UTF-8 first, fall back to Windows-1252 (German bank exports). */
function decodeCSV(buf){
  try{ return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch(e){ return new TextDecoder("windows-1252").decode(buf); }
}
function addFiles(list){
  const arr = [...list].filter(f => /\.csv$/i.test(f.name));
  if(!arr.length){ $("err").textContent = "Bitte CSV-Dateien auswählen."; return; }
  $("err").textContent = "";
  let pending = arr.length;
  arr.forEach(f => {
    const rd = new FileReader();
    rd.onerror = () => { if(--pending === 0) refresh(); };
    rd.onload = () => {
      const text = decodeCSV(rd.result);
      const det = X.detect(text, f.name);
      store.files = store.files.filter(x => x.name !== f.name);           // replace on re-add
      store.files.push({ name: f.name, text, conv: det ? det.conv.id : null, kind: det ? det.kind : "unknown" });
      if(--pending === 0) refresh();
    };
    rd.readAsArrayBuffer(f);
  });
}

const drop = $("drop");
drop.addEventListener("click", () => $("file").click());
drop.addEventListener("keydown", e => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); $("file").click(); } });
$("file").addEventListener("change", e => addFiles(e.target.files));
["dragover","dragenter"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("hot"); }));
["dragleave","dragend"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("hot")));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("hot"); addFiles(e.dataTransfer.files); });

$("fileList").addEventListener("click", e => {
  const btn = e.target.closest(".rm"); if(!btn) return;
  store.files.splice(+btn.dataset.i, 1);
  refresh();
});

$("resetBtn").addEventListener("click", () => {
  store.files = []; RESULT = null;
  $("file").value = ""; $("err").textContent = "";
  render();
});

$("downloadBtn").addEventListener("click", () => {
  if(!RESULT) return;
  const blob = new Blob(["﻿" + toCSV(RESULT.rows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "extraetf-import.csv"; a.click();
  URL.revokeObjectURL(a.href);
});
})();
