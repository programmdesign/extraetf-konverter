"use strict";
/* ============================================================================
   CapTrader (Interactive Brokers Flex Query) → ExtraETF converter module.
   ---------------------------------------------------------------------------
   Files: Trades-Flex-Query, Cash-Flex-Query (comma-CSV, one or more years each)
          + optional "Bestand" (IB activity statement) for position reconciling.

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

const X = globalThis.ExtraETF;
const { parseCSV, num, fmt, deDate, ISIN_RE, isISIN, norm, ETF_WORDS } = X;

function classifyTyp(assetClass, desc){
  if(assetClass === "BOND") return "Anleihe";
  if(ETF_WORDS.test((desc || "").toUpperCase())) return "ETF";
  return "Aktie";
}

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
function ingest(name, text, trades, cash){
  const rows = parseCSV(text);
  let mode = null, header = null;
  for(const r of rows){
    const has = k => r.indexOf(k) > -1;
    if(has("Buy/Sell") && has("ISIN")){ mode = "trade"; header = r; continue; }
    if(has("Type") && has("Amount") && has("CurrencyPrimary")){ mode = "cash"; header = r; continue; }
    if(r[0] === "Date/Time" && has("FromCurrency")){ mode = "fx"; header = null; continue; } // IB FX-rate table → skip
    if(!mode || !header || r.length !== header.length) continue;
    const o = {}; header.forEach((h,i)=>o[h]=r[i]);
    if(mode === "trade"){ o.__src = name; trades.push(o); }
    else if(mode === "cash"){ o.__src = name; cash.push(o); }
  }
}

/* ------------- display labels for the manual-entry cash summary ------------- */
const CASH_LABELS = {
  "Deposits/Withdrawals": "Ein-/Auszahlungen",
  "Broker Interest Received": "Broker-Zinsen erhalten",
  "Broker Interest Paid": "Broker-Zinsen gezahlt",
  "Bond Interest Paid": "Anleihe: Stückzinsen gezahlt (Kauf)",
  "Bond Interest Received": "Anleihe: Stückzinsen erhalten (Verkauf)",
  "Other Fees": "Sonstige Gebühren",
  "Quellensteuer auf Zinsen": "Quellensteuer auf Zinsen"
};
const COUPON_LABEL = "Anleihe-Kupons (als Dividende auf die Anleihe buchen)";
const CASH_ORDER = [COUPON_LABEL, ...Object.values(CASH_LABELS)];

/* ============================ conversion ============================ */
function convert(files){
  const trades = [], cash = []; let bestand = null;
  for(const f of files){
    if(f.kind === "bestand") bestand = parseBestand(f.text);
    else ingest(f.name, f.text, trades, cash);
  }

  const rows = [];
  const flags = { corp:[], fx:[], skipped:[], divNoIsin:[], unmatchedTax:[], nCanc:0 };
  const positions = {};        // isin → {name, typ, qty, lastPx, ccy}
  const bondName2Isin = {};    // "DBR 2.6 08/15/33" → ISIN (learned from bond trades)

  /* ---- 1) TRADES → Kauf / Verkauf ---- */
  for(const t of trades){
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
    rows.push({
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
  const cashSummary = {};               // display label → { ccy: {CUR: amount} }
  const addSummary = (label, ccy, amt) => {
    const s = cashSummary[label] || (cashSummary[label] = { ccy: {} });
    s.ccy[ccy] = (s.ccy[ccy] || 0) + amt;
  };
  for(const c of cash){
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
      else addSummary(CASH_LABELS["Quellensteuer auf Zinsen"], ccy, amt);          // WHT on interest → cash
    } else if(type === "Bond Interest Received" && /COUPON/i.test(desc)){
      const nm = (desc.match(/\((.+?)\s-\s/) || [])[1] ||
                 desc.replace(/BOND COUPON PAYMENT/i, "").replace(/[()]/g, "").trim();
      coupons.push({ date, name: nm, ccy, amount: amt, fx });
    } else {
      addSummary(CASH_LABELS[type] || type, ccy, amt); // deposits, interest, fees, accrued bond interest, …
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
    rows.push({
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
  for(const ccy in couponSum) addSummary(COUPON_LABEL, ccy, couponSum[ccy]);

  /* ---- 3) optional: reconcile final positions against the CapTrader Bestand ---- */
  const balAdds = [];
  if(bestand){
    const B = bestand, bdate = B.date || "";
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
      rows.push({
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

  /* ---- 4) banners + note tables (pure display data, rendered by app.js) ---- */
  const cell = (t, n) => n ? { t, num: true } : (t == null ? "" : "" + t);
  const banners = [ bestand
    ? { kind: "good", parts: [{ b: "✅ Bestand-Abgleich" }, balAdds.length
        ? ` — ${balAdds.length} Ausgleichsbuchung(en) zum ${bestand.date} ergänzt, damit die Positionen exakt dem CapTrader-Bestand entsprechen (Corporate Actions / fehlende Trades).`
        : ` — alle Positionen stimmen exakt mit dem CapTrader-Bestand (${bestand.date}) überein.`] }
    : { kind: "warn", parts: [{ b: "Tipp:" }, " Lade zusätzlich den CapTrader-", { b: "Bestand" },
        " hoch – dann ergänzt der Konverter automatisch Ein-/Ausbuchungen für Corporate Actions, sodass die Positionen exakt passen."] } ];

  const note = (title, items, cols, rowFn) =>
    items.length ? { title, cols, rows: items.map(rowFn) } : null;
  const notes = [];
  if(balAdds.length) notes.push(note("Bestand-Ausgleichsbuchungen", balAdds,
    ["ISIN", "Name", "Buchung", { t: "Stück", num: true }, { t: "rekonstr.→Ziel", num: true }],
    b => [cell(b.isin), cell(b.name), cell(b.resid > 0 ? "Einbuchung" : "Ausbuchung"),
          cell(fmt(Math.abs(b.resid)), true), cell(`${fmt(b.have)} → ${fmt(b.want)}`, true)]));
  notes.push(note("⚠︎ Corporate Actions / 0-Preis – in ExtraETF manuell prüfen", flags.corp,
    ["Datum", "Symbol", "ISIN", "Anzahl", "Beschreibung"],
    t => [cell(deDate(t.TradeDate)), cell(t.Symbol), cell(t.ISIN), cell(t.Quantity, true), cell(t.Description)]));
  notes.push(note("Währungsumrechnungen (keine Wertpapiere)", flags.fx,
    ["Datum", "Paar", "Anzahl", "Kurs", "Richtung"],
    t => [cell(deDate(t.TradeDate)), cell(t.Symbol), cell(t.Quantity, true), cell(t.TradePrice, true), cell(t["Buy/Sell"])]));
  notes.push(note("Übersprungen (fehlende ISIN/Werte)", flags.skipped,
    ["Beschreibung", "ISIN"],
    t => [cell(t.note || t.Description || ""), cell(t.ISIN || "")]));
  notes.push(note("Quellensteuer ohne passende Dividende", flags.unmatchedTax,
    ["Datum | ISIN", "Betrag"],
    t => [cell(t.k), cell(fmt(t.amt), true)]));
  if(flags.nCanc) notes.push({ banner: { kind: "good", parts: [
    { b: `${flags.nCanc} Stornierung(en) „(Ca.)“` },
    " erkannt – anhand der vorzeichenbehafteten Stückzahl korrekt gegengebucht."] } });

  return {
    rows, positions, cashSummary, cashOrder: CASH_ORDER,
    banners, notes: notes.filter(Boolean),
    stats: bestand ? [["Bestand-Abgleich", balAdds.length]] : []
  };
}

/* ============================ registration ============================ */
X.register({
  id: "captrader",
  label: "CapTrader",
  kindLabels: { trade: "Trades", cash: "Cash", bestand: "Bestand" },
  detect(text){
    if(/Buy\/Sell/.test(text)) return "trade";
    if(/Offene Positionen/.test(text) && /(Nettoverm|Kontoinformation)/.test(text)) return "bestand";
    if(/Amount/.test(text) && /Type/.test(text)) return "cash";
    return null;
  },
  convert
});

})();
