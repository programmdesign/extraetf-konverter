"use strict";
/* ============================================================================
   CapTrader (Interactive Brokers Flex Query) → ExtraETF CSV converter
   Single-file, dependency-free, runs entirely client-side.
   ---------------------------------------------------------------------------
   ExtraETF import spec (confirmed via support.extraetf.com, article 4744749535634):
     Datum;ISIN;Name;Typ;Transaktion;Preis;Anzahl;Gebühren;Steuern;Währung;Wechselkurs
     · Separator ';'  · German decimals (comma)  · Date TT.MM.JJJJ
     · Typ        ∈ Aktie, ETF, Fonds, Anleihe, Zertifikat/OS, Edelmetall, Fremdwährung
     · Transaktion∈ Kauf, Verkauf, Dividende, Kupon, Einbuchung, Ausbuchung
     · Preis      = execution price; Dividende → GROSS amount; Anleihe → Kurs in %
     · Anzahl     = shares; Dividende → 1; Anleihe → nominal value
     · Gebühren / Steuern = positive values (no minus sign)
     · Wechselkurs= foreign units per 1 EUR when not EUR, else 1,00  (= 1 / IB FXRateToBase)

   Verified on the platform (see README):
     · ExtraETF has no working "Kupon" type → bond coupons are NOT written to the CSV;
       they are listed under "Cash / Kontobuchungen" to be booked manually as a
       Dividende on the bond (flat amount) or as account interest.
     · Cash movements (deposits, interest, fees, accrued bond interest, FX conversions)
       cannot be CSV-imported → summarised for manual entry.
     · Uploading the "Bestand" (activity statement) lets the converter append balancing
       Einbuchung/Ausbuchung so the final positions match the statement exactly.
   ============================================================================ */

(function () {

/* ----------------------------- CSV parsing ----------------------------- */
/** Minimal RFC-4180-style parser → array of string rows. Handles quotes, CRLF, BOM. */
function parseCSV(text){
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], field = "", quoted = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(quoted){
      if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else quoted = false; }
      else field += c;
    } else {
      if(c === '"') quoted = true;
      else if(c === ",") { row.push(field); field = ""; }
      else if(c === "\n"){ row.push(field); rows.push(row); row = []; field = ""; }
      else if(c === "\r"){ /* ignore */ }
      else field += c;
    }
  }
  if(field !== "" || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
}

/* ----------------------------- formatting helpers ----------------------------- */
/** Parse a numeric string using '.' as decimal separator (CapTrader format). */
const num = s => { if(s == null) return NaN; s = ("" + s).trim(); return s === "" ? NaN : parseFloat(s); };

/** Number → German string (comma decimal, no thousands separator, ≤6 dp, trimmed). */
function fmt(x){
  if(x === "" || x == null || (typeof x === "number" && isNaN(x))) return "";
  const n = typeof x === "number" ? x : parseFloat(x);
  if(isNaN(n)) return "";
  let s = (Math.round(n * 1e6) / 1e6).toString();
  if(s.indexOf("e") > -1) s = n.toFixed(6);
  return s.replace(".", ",");
}

/** 'DD/MM/YYYY[ HH:MM:SS]' (or ISO) → 'DD.MM.YYYY'. */
function deDate(s){
  if(!s) return "";
  const d = ("" + s).trim().split(/[ T]/)[0];
  let m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(m) return `${m[1]}.${m[2]}.${m[3]}`;
  m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) return `${m[3]}.${m[2]}.${m[1]}`;
  return d;
}

/** Sort key: 'DD.MM.YYYY' → 'YYYYMMDD' (balancing rows sort last via '9' prefix). */
const sortKey = r => (r._bal ? "9" : "0") + (("" + (r.d || "")).split(".").reverse().join(""));

const ISIN_RE = /\(([A-Z]{2}[A-Z0-9]{9}\d)\)/;              // ISIN embedded in "(...)"
const isISIN  = s => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s || "");
const norm    = s => ("" + s).replace(/\s+/g, " ").trim().toUpperCase();

/* ------------------- security type hint (ExtraETF re-detects by ISIN) ------------------- */
const ETF_WORDS = /\b(ETF|ETP|ETN|UCITS|ISHARES|XTRACKERS|X TRACKERS|AMUNDI|LYXOR|VANECK|VAN ECK|INVESCO|SPDR|WISDOMTREE|FRANKLIN|FRK|HANETF|GLOBAL X|21SHARES|COINSHARES|BITWISE|VANGUARD|SWAP)\b/;
function classifyTyp(assetClass, desc){
  if(assetClass === "BOND") return "Anleihe";
  if(ETF_WORDS.test((desc || "").toUpperCase())) return "ETF";
  return "Aktie";
}

/* ----------------------------- app state ----------------------------- */
const store = { files: [], trades: [], cash: [], bestand: null };

/* ------------- parse CapTrader "Bestand" (IB activity statement, comma-CSV) ------------- */
function parseBestandDate(s){
  const M = {januar:1,februar:2,"märz":3,maerz:3,april:4,mai:5,juni:6,juli:7,august:8,september:9,oktober:10,november:11,dezember:12};
  if(!s) return "";
  let m = s.match(/([A-Za-zäöüÄÖÜ]+)\s+(\d{1,2}),?\s+(\d{4})/);          // "Juni 30, 2026"
  if(m){ const mo = M[m[1].toLowerCase()] || 1; return `${("0"+m[2]).slice(-2)}.${("0"+mo).slice(-2)}.${m[3]}`; }
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}
function parseBestand(text){
  const rows = parseCSV(text);
  const sym2isin = {}, fxrate = {}; let period = "", ipHdr = null, opHdr = null; const positions = [];
  for(const r of rows){
    const sec = r[0];
    if(sec === "Statement" && r[1] === "Data" && r[2] === "Period") period = r[3];
    else if(sec === "Informationen zum Finanzinstrument"){
      if(r[1] === "Header") ipHdr = r.slice(2);
      else if(r[1] === "Data" && ipHdr){ const o = {}; ipHdr.forEach((h,i)=>o[h]=r[2+i]);
        if(o["Symbol"]) sym2isin[o["Symbol"]] = o["Wertpapier-ID"]; }
    }
    else if(sec === "Wechselkurs der Basiswährung" && r[1] === "Data") fxrate[r[2]] = parseFloat(r[3]);
    else if(sec === "Offene Positionen"){
      if(r[1] === "Header") opHdr = r.slice(2);
      else if(r[1] === "Data" && opHdr){ const o = {}; opHdr.forEach((h,i)=>o[h]=r[2+i]);
        if(o["DataDiscriminator"] !== "Summe" && o["Menge"] != null && o["Menge"] !== "") positions.push(o); }
    }
  }
  return { date: parseBestandDate(period) || period, sym2isin, fxrate, positions };
}

/* ------------- ingest one file: split a multi-section IB CSV by header signature ------------- */
function ingest(name, text){
  const rows = parseCSV(text);
  let mode = null, header = null, nTrade = 0, nCash = 0;
  for(const r of rows){
    const has = k => r.indexOf(k) > -1;
    if(has("Buy/Sell") && has("ISIN")){ mode = "trade"; header = r; continue; }
    if(has("Type") && has("Amount") && has("CurrencyPrimary")){ mode = "cash"; header = r; continue; }
    if(r[0] === "Date/Time" && has("FromCurrency")){ mode = "fx"; header = null; continue; } // IB FX-rate table → skip
    if(!mode || !header || r.length !== header.length) continue;
    const o = {}; header.forEach((h,i)=>o[h]=r[i]);
    if(mode === "trade"){ o.__src = name; store.trades.push(o); nTrade++; }
    else if(mode === "cash"){ o.__src = name; store.cash.push(o); nCash++; }
  }
  return { nTrade, nCash };
}

/* ============================ conversion core ============================ */
function convert(){
  const outRows = [];
  const flags = { corp:[], fx:[], skipped:[], divNoIsin:[], unmatchedTax:[], nCanc:0 };
  const positions = {};        // isin → {name, typ, qty, lastPx, ccy}
  const bondName2Isin = {};    // "DBR 2.6 08/15/33" → ISIN (learned from bond trades)

  /* ---- 1) TRADES → Kauf / Verkauf ---- */
  for(const t of store.trades){
    const ac = t.AssetClass, bsRaw = t["Buy/Sell"] || "";
    const qty = num(t.Quantity), price = num(t.TradePrice);
    const isin = (t.ISIN || "").trim();
    const name = (t.Description || "").trim();

    if(ac === "CASH"){ flags.fx.push(t); continue; }                              // FX conversion (e.g. EUR.USD)
    if(t.ListingExchange === "CORPACT" || (price === 0 && ac !== "CASH")){        // corporate action / 0-price
      flags.corp.push(t); continue;
    }
    if(!isin || isNaN(qty) || isNaN(price) || qty === 0){ flags.skipped.push(t); continue; }

    const typ = classifyTyp(ac, name);
    if(ac === "BOND") bondName2Isin[norm(name)] = isin;
    const ccy = (t.CurrencyPrimary || "EUR").trim();
    const fxToBase = num(t.FXRateToBase);
    const wk = (ccy === "EUR" || !fxToBase) ? "1,00" : fmt(1 / fxToBase);

    // IB "Quantity" is signed (+buy / −sell). Cancellations are labelled "BUY (Ca.)" but carry a
    // NEGATIVE quantity, so the sign — not the Buy/Sell label — is authoritative.
    if(/\(Ca\.\)/i.test(bsRaw)) flags.nCanc++;
    outRows.push({
      d: deDate(t.TradeDate), isin, name, typ,
      tx: qty < 0 ? "Verkauf" : "Kauf",
      preis: fmt(price), anzahl: fmt(Math.abs(qty)),
      geb: fmt(Math.abs(num(t.IBCommission)) || 0), st: fmt(Math.abs(num(t.Taxes)) || 0),
      ccy, wk
    });
    const p = positions[isin] || (positions[isin] = { name, typ, qty: 0 });
    p.qty += qty;                        // signed quantity is authoritative
    p.lastPx = price; p.ccy = ccy;       // fallbacks for the Bestand reconcile
  }

  /* ---- 2) CASH → aggregate dividends + withholding tax + coupons; route the rest ---- */
  const divByKey = {}, whtByKey = {}, coupons = [];
  const cashSummary = {};               // Type → { ccy: {CUR: amount} }
  const addSummary = (type, ccy, amt) => {
    const s = cashSummary[type] || (cashSummary[type] = { ccy: {} });
    s.ccy[ccy] = (s.ccy[ccy] || 0) + amt;
  };
  for(const c of store.cash){
    const type = c.Type, ccy = (c.CurrencyPrimary || "EUR").trim();
    const amt = num(c.Amount), date = deDate(c["Date/Time"]);
    const desc = c.Description || "";
    const m = desc.match(ISIN_RE); const isin = m ? m[1] : "";
    const fx = num(c.FXRateToBase);

    if(type === "Dividends"){
      if(!isin) flags.divNoIsin.push(c);
      const k = `${date}|${isin}|${ccy}`;
      const g = divByKey[k] || (divByKey[k] = { date, isin, ccy, amount: 0, fx,
        name: desc.split(/\(|CASH DIVIDEND/)[0].trim() || isin });
      g.amount += amt;
    } else if(type === "Withholding Tax"){
      if(isin){ const k = `${date}|${isin}`; whtByKey[k] = (whtByKey[k] || 0) + amt; }
      else addSummary("Quellensteuer auf Zinsen", ccy, amt);                       // WHT on interest → cash
    } else if(type === "Bond Interest Received" && /COUPON/i.test(desc)){
      const nm = (desc.match(/\((.+?)\s-\s/) || [])[1] ||
                 desc.replace(/BOND COUPON PAYMENT/i, "").replace(/[()]/g, "").trim();
      coupons.push({ date, name: nm, ccy, amount: amt, fx });
    } else {
      addSummary(type, ccy, amt);      // deposits, broker interest, fees, accrued bond interest, …
    }
  }

  /* dividends → "Dividende" (GROSS price, tax matched by date+ISIN, then ±7-day fallback) */
  const usedTax = {};
  for(const g of Object.values(divByKey).sort((a,b)=>a.date > b.date ? 1 : -1)){
    if(Math.abs(g.amount) < 1e-9) continue;
    let taxKey = `${g.date}|${g.isin}`, wht = whtByKey[taxKey];
    if(wht == null && g.isin){
      const [dd,mm,yy] = g.date.split(".").map(Number); const base = new Date(yy, mm-1, dd);
      for(const k in whtByKey){
        const [dk, ik] = k.split("|"); if(ik !== g.isin || usedTax[k]) continue;
        const [d2,m2,y2] = dk.split(".").map(Number);
        if(Math.abs((new Date(y2, m2-1, d2) - base) / 864e5) <= 7){ wht = whtByKey[k]; taxKey = k; break; }
      }
    }
    usedTax[taxKey] = true;
    outRows.push({
      d: g.date, isin: g.isin, name: g.name || g.isin,
      typ: (positions[g.isin] && positions[g.isin].typ) || "Aktie",
      tx: "Dividende", preis: fmt(g.amount), anzahl: "1",
      geb: "0", st: fmt(wht != null && wht < 0 ? -wht : 0),
      ccy: g.ccy, wk: (g.ccy === "EUR" || !g.fx) ? "1,00" : fmt(1 / g.fx)
    });
  }
  for(const k in whtByKey){ if(!usedTax[k] && whtByKey[k] < 0) flags.unmatchedTax.push({ k, amt: whtByKey[k] }); }

  /* bond coupons: ExtraETF has no working "Kupon" type (CSV import turns it into a "Kauf" and
     applies bond %-pricing). Coupons are income and don't change the position, so they are kept
     OUT of the CSV and listed for manual entry (best booked as a Dividende on the bond). */
  const couponSum = {};
  for(const cp of coupons){ couponSum[cp.ccy] = (couponSum[cp.ccy] || 0) + cp.amount; }
  for(const ccy in couponSum) addSummary("Anleihe-Kupons (als Dividende auf die Anleihe buchen)", ccy, couponSum[ccy]);

  /* ---- 3) optional: reconcile final positions against the CapTrader Bestand ---- */
  const balAdds = [];
  if(store.bestand){
    const B = store.bestand, bdate = B.date || "";
    const tgt = {};
    for(const o of B.positions){
      let isin = B.sym2isin[o["Symbol"]] || o["Symbol"] || "";
      if(!isISIN(isin)){                                          // bonds & unmatched → map via bond trades
        isin = bondName2Isin[norm(isin)] || bondName2Isin[norm(isin.split(" - ")[0])] || isin;
      }
      const q = num(o["Menge"]); if(isNaN(q)) continue;
      const t = tgt[isin] || (tgt[isin] = { qty: 0, ccy: (o["Währung"] || "EUR").trim(),
        price: num(o["Schlusskurs"]), name: o["Symbol"] || isin });
      t.qty += q;
    }
    for(const isin of new Set([...Object.keys(positions), ...Object.keys(tgt)])){
      const have = positions[isin] ? positions[isin].qty : 0;
      const want = tgt[isin] ? tgt[isin].qty : 0;
      const resid = want - have;
      if(Math.abs(resid) < 1e-3) continue;
      const ti = tgt[isin] || {}, nmeta = positions[isin] || {};
      const ccy = ti.ccy || nmeta.ccy || "EUR";
      // Einbuchung → value at Bestand close price; Ausbuchung of a phantom → last trade price (P&L-neutral)
      const price = (ti.price != null && !isNaN(ti.price)) ? ti.price : (nmeta.lastPx || 0);
      outRows.push({
        d: bdate, isin, name: nmeta.name || ti.name || isin,
        typ: nmeta.typ || (isISIN(isin) ? "Aktie" : "Anleihe"),
        tx: resid > 0 ? "Einbuchung" : "Ausbuchung",
        preis: fmt(price), anzahl: fmt(Math.abs(resid)),
        geb: "0", st: "0", ccy, wk: (ccy === "EUR" || !B.fxrate[ccy]) ? "1,00" : fmt(1 / B.fxrate[ccy]),
        _bal: true
      });
      balAdds.push({ isin, name: nmeta.name || ti.name || isin, resid, have, want });
      if(!positions[isin]) positions[isin] = { name: ti.name || isin, typ: isISIN(isin) ? "Aktie" : "Anleihe", qty: 0 };
      positions[isin].qty += resid;     // reflect reconciled qty in the positions table
    }
  }

  outRows.sort((a,b)=>{ const ka = sortKey(a), kb = sortKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  return { outRows, flags, positions, cashSummary, balAdds };
}

/* ============================ CSV output ============================ */
const HEADER = ["Datum","ISIN","Name","Typ","Transaktion","Preis","Anzahl","Gebühren","Steuern","Währung","Wechselkurs"];
function toCSV(rows){
  const esc = v => { v = (v == null ? "" : "" + v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
  const lines = [HEADER.join(";")];
  for(const r of rows) lines.push([r.d,r.isin,r.name,r.typ,r.tx,r.preis,r.anzahl,r.geb,r.st,r.ccy,r.wk].map(esc).join(";"));
  return lines.join("\r\n");
}

/* ============================ UI rendering ============================ */
const $ = id => document.getElementById(id);
const esc = s => ("" + (s == null ? "" : s)).replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const pillCls = typ => "pill " + ("" + typ).replace(/[^A-Za-z]/g, "");
let RESULT = null;

const KIND_LABEL = { trade: "Trades", cash: "Cash", bestand: "Bestand", unknown: "?" };
const CASH_LABELS = {
  "Deposits/Withdrawals": "Ein-/Auszahlungen",
  "Broker Interest Received": "Broker-Zinsen erhalten",
  "Broker Interest Paid": "Broker-Zinsen gezahlt",
  "Bond Interest Paid": "Anleihe: Stückzinsen gezahlt (Kauf)",
  "Bond Interest Received": "Anleihe: Stückzinsen erhalten (Verkauf)",
  "Other Fees": "Sonstige Gebühren",
  "Quellensteuer auf Zinsen": "Quellensteuer auf Zinsen"
};
const CASH_ORDER = ["Anleihe-Kupons (als Dividende auf die Anleihe buchen)","Deposits/Withdrawals",
  "Broker Interest Received","Broker Interest Paid","Bond Interest Paid","Bond Interest Received",
  "Other Fees","Quellensteuer auf Zinsen"];

function refresh(){
  $("err").textContent = "";
  store.trades = []; store.cash = []; store.bestand = null;
  for(const f of store.files){
    if(f.kind === "bestand"){
      try{ store.bestand = parseBestand(f.text); }
      catch(e){ console.error(e); $("err").textContent = "Bestand-Datei konnte nicht gelesen werden."; }
      continue;
    }
    ingest(f.name, f.text);
  }
  RESULT = store.files.length ? convert() : null;
  render();
}

function renderFiles(){
  $("fileList").innerHTML = store.files.map((f, i) =>
    `<li class="file"><span class="badge ${f.kind}">${KIND_LABEL[f.kind] || "?"}</span>` +
    `<span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>` +
    `<button class="rm" data-i="${i}" aria-label="Entfernen">×</button></li>`).join("");
}

function render(){
  renderFiles();
  if(!RESULT){ $("results").classList.add("hidden"); return; }
  $("results").classList.remove("hidden");
  const { outRows, flags, positions, cashSummary, balAdds } = RESULT;
  const count = tx => outRows.filter(r => r.tx === tx).length;
  const openPos = Object.values(positions).filter(p => Math.abs(p.qty) > 1e-6).length;

  /* summary stat cards */
  const stats = [
    ["Transaktionen", outRows.length], ["Käufe", count("Kauf")], ["Verkäufe", count("Verkauf")],
    ["Dividenden", count("Dividende")], ["Offene Positionen", openPos]
  ];
  if(store.bestand) stats.push(["Bestand-Abgleich", balAdds.length]);
  $("summary").innerHTML = stats.map(([l,n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");

  /* reconcile banner */
  let rec = "";
  if(store.bestand){
    rec = balAdds.length
      ? `<div class="banner good"><b>✅ Bestand-Abgleich</b> — ${balAdds.length} Ausgleichsbuchung(en) zum ${esc(store.bestand.date)} ergänzt, damit die Positionen exakt dem CapTrader-Bestand entsprechen (Corporate Actions / fehlende Trades).</div>`
      : `<div class="banner good"><b>✅ Bestand-Abgleich</b> — alle Positionen stimmen exakt mit dem CapTrader-Bestand (${esc(store.bestand.date)}) überein.</div>`;
  } else {
    rec = `<div class="banner warn"><b>Tipp:</b> Lade zusätzlich den CapTrader-<b>Bestand</b> hoch – dann ergänzt der Konverter automatisch Ein-/Ausbuchungen für Corporate Actions, sodass die Positionen exakt passen.</div>`;
  }
  $("reconcile").innerHTML = rec;

  /* preview table */
  $("preview").querySelector("thead").innerHTML = "<tr>" + HEADER.map(h => `<th>${h}</th>`).join("") + "</tr>";
  $("preview").querySelector("tbody").innerHTML = outRows.map(r =>
    `<tr class="${r._bal ? "bal" : ""}"><td>${esc(r.d)}</td><td>${esc(r.isin)}</td><td>${esc(r.name)}</td>` +
    `<td><span class="${pillCls(r.typ)}">${esc(r.typ)}</span></td><td>${esc(r.tx)}</td>` +
    `<td class="num">${esc(r.preis)}</td><td class="num">${esc(r.anzahl)}</td><td class="num">${esc(r.geb)}</td>` +
    `<td class="num">${esc(r.st)}</td><td>${esc(r.ccy)}</td><td class="num">${esc(r.wk)}</td></tr>`).join("");
  $("rowcount").textContent = `· ${outRows.length} Zeilen`;

  /* positions table */
  const pos = Object.entries(positions).filter(([,p]) => Math.abs(p.qty) > 1e-6)
    .sort((a,b) => a[1].name.localeCompare(b[1].name));
  $("positions").querySelector("thead").innerHTML = "<tr><th>ISIN</th><th>Name</th><th>Typ</th><th class='num'>Netto-Stück</th></tr>";
  $("positions").querySelector("tbody").innerHTML = pos.map(([isin,p]) =>
    `<tr><td>${esc(isin)}</td><td>${esc(p.name)}</td><td><span class="${pillCls(p.typ)}">${esc(p.typ)}</span></td>` +
    `<td class="num">${fmt(p.qty)}</td></tr>`).join("");

  /* notes / flags */
  const block = (title, cls, items, cols, fn) => items.length
    ? `<details class="card"><summary>${title} <span class="cnt">${items.length}</span></summary>` +
      `<div class="tablewrap"><table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join("")}</tr></thead>` +
      `<tbody>${items.map(fn).join("")}</tbody></table></div></details>` : "";
  let fh = "";
  if(balAdds.length) fh += `<details class="card"><summary>Bestand-Ausgleichsbuchungen <span class="cnt">${balAdds.length}</span></summary>` +
    `<div class="tablewrap"><table><thead><tr><th>ISIN</th><th>Name</th><th>Buchung</th><th class="num">Stück</th><th class="num">rekonstr.→Ziel</th></tr></thead><tbody>` +
    balAdds.map(b => `<tr><td>${esc(b.isin)}</td><td>${esc(b.name)}</td><td>${b.resid>0?"Einbuchung":"Ausbuchung"}</td>` +
      `<td class="num">${fmt(Math.abs(b.resid))}</td><td class="num">${fmt(b.have)} → ${fmt(b.want)}</td></tr>`).join("") +
    `</tbody></table></div></details>`;
  fh += block("⚠︎ Corporate Actions / 0-Preis – in ExtraETF manuell prüfen", "", flags.corp,
    ["Datum","Symbol","ISIN","Anzahl","Beschreibung"],
    t => `<tr><td>${deDate(t.TradeDate)}</td><td>${esc(t.Symbol)}</td><td>${esc(t.ISIN)}</td><td class="num">${esc(t.Quantity)}</td><td>${esc(t.Description)}</td></tr>`);
  fh += block("Währungsumrechnungen (keine Wertpapiere)", "", flags.fx,
    ["Datum","Paar","Anzahl","Kurs","Richtung"],
    t => `<tr><td>${deDate(t.TradeDate)}</td><td>${esc(t.Symbol)}</td><td class="num">${esc(t.Quantity)}</td><td class="num">${esc(t.TradePrice)}</td><td>${esc(t["Buy/Sell"])}</td></tr>`);
  fh += block("Übersprungen (fehlende ISIN/Werte)", "", flags.skipped,
    ["Beschreibung","ISIN"],
    t => `<tr><td>${esc(t.note||t.Description||"")}</td><td>${esc(t.ISIN||"")}</td></tr>`);
  fh += block("Quellensteuer ohne passende Dividende", "", flags.unmatchedTax,
    ["Datum | ISIN","Betrag"],
    t => `<tr><td>${esc(t.k)}</td><td class="num">${fmt(t.amt)}</td></tr>`);
  if(flags.nCanc) fh += `<div class="banner good"><b>${flags.nCanc} Stornierung(en) „(Ca.)“</b> erkannt – anhand der vorzeichenbehafteten Stückzahl korrekt gegengebucht.</div>`;
  $("flags").innerHTML = fh ? `<div class="step-head" style="margin-top:22px">Hinweise</div>${fh}` : "";

  /* cash summary */
  const keys = Object.keys(cashSummary).sort((a,b) => (CASH_ORDER.indexOf(a)+99) - (CASH_ORDER.indexOf(b)+99));
  let ch = `<p style="margin-top:0">Diese Buchungen lassen sich in ExtraETF <b>nicht per CSV</b> importieren. Erfasse sie bei Bedarf manuell über <b>„Neue Aktivität → Cash“</b> ` +
    `(<a href="https://support.extraetf.com/hc/de/articles/14644488296476" target="_blank" rel="noopener">Anleitung</a>) und aktiviere „Berücksichtigen“, damit Cash zum Gesamtvermögen zählt. ` +
    `<b>Anleihe-Kupons</b> bucht man am besten als <em>Dividende auf die jeweilige Anleihe</em> (ExtraETF hat keinen Kupon-Typ).</p>`;
  if(keys.length){
    ch += `<div class="tablewrap"><table><thead><tr><th>Buchungsart</th><th>Beträge je Währung</th></tr></thead><tbody>` +
      keys.map(k => {
        const parts = Object.entries(cashSummary[k].ccy).map(([c,v]) => `${fmt(Math.round(v*100)/100)} ${c}`).join(" · ");
        return `<tr><td>${esc(CASH_LABELS[k] || k)}</td><td class="num">${parts}</td></tr>`;
      }).join("") + `</tbody></table></div>`;
  } else ch += `<p class="muted">Keine Cash-Buchungen gefunden.</p>`;
  $("cashbox").innerHTML = ch;

  $("downloadBtn").disabled = outRows.length === 0;
  $("rowInfo").textContent = outRows.length ? `· ${outRows.length} Zeilen` : "";
}

/* ============================ file handling & events ============================ */
function detectKind(text){
  if(/Buy\/Sell/.test(text)) return "trade";
  if(/Offene Positionen/.test(text) && /(Nettoverm|Kontoinformation)/.test(text)) return "bestand";
  if(/Amount/.test(text) && /Type/.test(text)) return "cash";
  return "unknown";
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
      const text = rd.result;
      store.files = store.files.filter(x => x.name !== f.name);           // replace on re-add
      store.files.push({ name: f.name, text, kind: detectKind(text) });
      if(--pending === 0) refresh();
    };
    rd.readAsText(f, "utf-8");
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
  store.files = []; store.trades = []; store.cash = []; store.bestand = null; RESULT = null;
  $("file").value = ""; $("err").textContent = "";
  render();
});

$("downloadBtn").addEventListener("click", () => {
  if(!RESULT) return;
  const blob = new Blob(["﻿" + toCSV(RESULT.outRows)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "extraetf-import.csv"; a.click();
  URL.revokeObjectURL(a.href);
});
})();
