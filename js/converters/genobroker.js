"use strict";
/* ============================================================================
   GenoBroker (GENO Broker GmbH, Volks- & Raiffeisenbanken) → ExtraETF converter.
   ---------------------------------------------------------------------------
   Files (kind):
     umsaetze — "Depotumsatzanzeige" CSV (Depotumsaetze_<depot>_<datum>.csv):
       semicolon-separated, German decimals ("1.820,30"), dates TT.MM.JJJJ;
       metadata block, then one table with header
       Wertpapierart; Name; WKN; Geschäftsart; Datum; Auftrags-Nr.; Stück/Nominal;
       Ausführungskurs; Währung; Stückzinsen in EUR; Kurswert inkl. Stückzinsen in EUR;
       Spesen in EUR; Steuern in EUR; Abrechnungsbetrag
     bestand  — "Depotbestand" CSV (Depotbestand_<depot>_<datum>.csv), optional:
       Name;WKN;Stück/Nominal;…;Aktueller Kurs;Kurswert in EUR;… — used to reconcile.

   Mapping decisions:
     · The export carries only WKNs (no ISIN) → the WKN goes into the ISIN column;
       a banner tells the user to double-check that ExtraETF resolved every security.
     · Preis = Kurswert / Stück (not the printed Ausführungskurs): savings-plan rows
       are amount-based ("400,00 EUR"), ExtraETF books Preis × Anzahl, and in older
       exports the Ausführungskurs column even contains the Abrechnungsbetrag —
       the effective price is correct in every observed format.
     · Overlapping exports (e.g. 11/2024–01/2026 + 07/2025–07/2026) are deduplicated
       by WKN + Auftrags-Nr. (fallback: Geschäftsart|Datum|WKN|Stück|Betrag).
     · TRANSAKTIONSART_AUSLIEFERUNGEN / EINLIEFERUNGEN (Depotüberträge) →
       Ausbuchung / Einbuchung at the row's effective price.
     · ERTRAGSART_AUSSCHUETTUNGEN with Kurswert 0 and only Steuern (negative
       Abrechnungsbetrag, early January, accumulating funds) is the Vorabpauschale →
       not CSV-importable, listed for manual entry. With a real payout the row becomes
       a Dividende (Preis = Brutto = Abrechnungsbetrag + Steuern).
     · With a Depotbestand: quantities in the Umsatzanzeige are rounded to 2 dp
       (the Bestand shows 4 dp), so reconstructed positions drift by a few 1/1000
       shares — balancing Einbuchung/Ausbuchung rows are appended so the final
       positions match the Bestand exactly.
   ============================================================================ */

(function () {

const X = globalThis.ExtraETF;
const { parseCSV, numDE, fmt, ETF_WORDS } = X;

const VORAB_LABEL = "Vorabpauschale / Steuern ohne Ausschüttung (manuell als Steuer buchen)";

function typOf(art, name){
  const a = (art || "").toLowerCase();
  const etf = ETF_WORDS.test((name || "").toUpperCase());
  if(/fonds|geldmarkt/.test(a)) return etf ? "ETF" : "Fonds";
  if(/rente|anleihe/.test(a)) return "Anleihe";
  if(/zertifikat|options/.test(a)) return "Zertifikat/OS";
  return etf ? "ETF" : "Aktie";
}

/* ------------- parse the optional "Depotbestand" file ------------- */
function parseBestand(text){
  const positions = {}; let date = "", idx = null;
  for(const r of parseCSV(text, ";")){
    const c = r.map(x => (x == null ? "" : "" + x).trim());
    const di = c.indexOf("Datum/Uhrzeit");
    if(di > -1 && c[di+1]){ const m = c[di+1].match(/(\d{2}\.\d{2}\.\d{4})/); if(m) date = m[1]; }
    if(c[0] === "Name" && c[1] === "WKN"){ idx = {}; r.forEach((h,i)=>idx[h.trim()]=i); continue; }
    if(!idx) continue;
    const g = k => (idx[k] == null || r[idx[k]] == null ? "" : ("" + r[idx[k]]).trim());
    const wkn = g("WKN").toUpperCase();
    const stk = g("Stück/Nominal");
    if(!wkn || !stk) continue;                              // footer/blank lines
    const qty = numDE(stk.replace(/\s*(Stk\.?|%)\s*$/i, ""));
    if(isNaN(qty)) continue;
    const price = numDE(g("Aktueller Kurs").replace(/\s*[A-Z]{3}\s*$/, ""));
    positions[wkn] = { name: g("Name").replace(/\s+/g, " "), qty, price };
  }
  return { date, positions };
}

function convert(files){
  const rows = [], positions = {}, vorab = [], skipped = [], balAdds = [];
  const cashSummary = {};
  let bestand = null, dups = 0;
  const addSummary = (label, ccy, amt) => {
    const s = cashSummary[label] || (cashSummary[label] = { ccy: {} });
    s.ccy[ccy] = (s.ccy[ccy] || 0) + amt;
  };

  const seen = new Set();   // dedupe across overlapping Umsätze exports
  for(const f of files){
    if(f.kind === "bestand"){ bestand = parseBestand(f.text); continue; }
    let idx = null;
    for(const r of parseCSV(f.text, ";")){
      if((r[0] || "").trim() === "Wertpapierart" && r.some(x => (x || "").trim() === "WKN")){
        idx = {}; r.forEach((h, i) => idx[h.trim()] = i);
        continue;
      }
      if(!idx) continue;                                   // metadata block before the table
      const g = k => (idx[k] == null || r[idx[k]] == null ? "" : ("" + r[idx[k]]).trim());
      const ga = g("Geschäftsart");
      if(!ga) continue;

      const name = g("Name").replace(/\s+/g, " ");
      const wkn = g("WKN").toUpperCase();
      const date = g("Datum");                             // already TT.MM.JJJJ
      const qty = numDE(g("Stück/Nominal"));
      const exPrice = numDE(g("Ausführungskurs"));
      const ccy = g("Währung") || "EUR";
      const stz = numDE(g("Stückzinsen in EUR")) || 0;
      const kurswert = numDE(g("Kurswert inkl. Stückzinsen in EUR"));
      const fees = numDE(g("Spesen in EUR"));
      const tax = numDE(g("Steuern in EUR"));
      const settle = numDE(g("Abrechnungsbetrag"));
      const typ = typOf(g("Wertpapierart"), name);

      // Same Auftrags-Nr. = same transaction, no matter which export it came from.
      const ordNr = g("Auftrags-Nr.");
      const key = (ordNr && ordNr !== "-") ? `${wkn}|${ordNr}`
        : `${ga}|${date}|${wkn}|${g("Stück/Nominal")}|${g("Abrechnungsbetrag")}`;
      if(seen.has(key)){ dups++; continue; }
      seen.add(key);

      // Effective price from the EUR-Kurswert (see header comment).
      const kw = (isNaN(kurswert) ? NaN : Math.abs(kurswert) - Math.abs(stz));
      const effPrice = (!isNaN(kw) && kw > 0 && !isNaN(qty) && qty !== 0)
        ? kw / Math.abs(qty) : Math.abs(exPrice);
      const pos = () => positions[wkn] || (positions[wkn] = { name, typ, qty: 0 });

      if(/AUSLIEFER|EINLIEFER/.test(ga)){                  // Depotübertrag raus/rein
        const out = /AUSLIEFER/.test(ga);
        if(!wkn || isNaN(qty) || qty === 0){ skipped.push({ date, name, wkn, ga }); continue; }
        rows.push({
          d: date, isin: wkn, name, typ,
          tx: out ? "Ausbuchung" : "Einbuchung",
          preis: fmt(isNaN(effPrice) ? 0 : effPrice), anzahl: fmt(Math.abs(qty)),
          geb: "0", st: "0", ccy: "EUR", wk: "1,00"
        });
        const p = pos();
        p.qty += out ? -Math.abs(qty) : Math.abs(qty);
        if(!isNaN(effPrice)) p.lastPx = effPrice;
      }
      else if(/KAEUFE|KAUF|VERKAEUFE|VERKAUF/.test(ga)){
        const sell = /VERKAEUFE|VERKAUF/.test(ga);
        if(!wkn || isNaN(qty) || qty === 0 || (isNaN(exPrice) && isNaN(kurswert))){
          skipped.push({ date, name, wkn, ga }); continue;
        }
        let preis = effPrice, useCcy = "EUR", wk = "1,00";
        if(ccy !== "EUR" && !isNaN(exPrice) && !isNaN(kw) && kw > 0){
          // Kurswert is in EUR → derive Wechselkurs (foreign units per EUR) from the pair.
          preis = Math.abs(exPrice); useCcy = ccy;
          wk = fmt(Math.abs(qty) * Math.abs(exPrice) / kw);
        }
        rows.push({
          d: date, isin: wkn, name, typ,
          tx: sell ? "Verkauf" : "Kauf",
          preis: fmt(preis), anzahl: fmt(Math.abs(qty)),
          geb: fmt(isNaN(fees) ? 0 : Math.abs(fees)), st: fmt(isNaN(tax) ? 0 : Math.abs(tax)),
          ccy: useCcy, wk
        });
        const p = pos();
        p.qty += sell ? -Math.abs(qty) : Math.abs(qty);
        if(!isNaN(effPrice)) p.lastPx = effPrice;
      }
      else if(/AUSSCHUETTUNG|DIVIDENDE|ERTRAG/.test(ga)){
        const brutto = (isNaN(settle) ? 0 : settle) + (isNaN(tax) ? 0 : Math.abs(tax));
        if(brutto > 1e-9){
          rows.push({
            d: date, isin: wkn, name, typ,
            tx: "Dividende", preis: fmt(brutto), anzahl: "1",
            geb: "0", st: fmt(isNaN(tax) ? 0 : Math.abs(tax)),
            ccy: "EUR", wk: "1,00"                          // Beträge laut Export in EUR
          });
        } else if(!isNaN(tax) && Math.abs(tax) > 1e-9){     // Vorabpauschale: tax only, no payout
          vorab.push({ date, name, wkn, tax: Math.abs(tax) });
          addSummary(VORAB_LABEL, "EUR", -(Math.abs(tax)));
        }
        if(!positions[wkn]) positions[wkn] = { name, typ, qty: 0 };   // known security, qty unknown
      }
      else skipped.push({ date, name, wkn, ga });
    }
  }

  /* ---- optional: reconcile final positions against the Depotbestand.
     Also fixes the 2-dp quantity rounding of the Umsatzanzeige. ---- */
  if(bestand){
    for(const wkn of new Set([...Object.keys(positions), ...Object.keys(bestand.positions)])){
      const have = positions[wkn] ? positions[wkn].qty : 0;
      const want = bestand.positions[wkn] ? bestand.positions[wkn].qty : 0;
      const resid = want - have;
      if(Math.abs(resid) < 5e-5) continue;                 // Bestand precision is 4 dp
      const bp = bestand.positions[wkn] || {}, meta = positions[wkn] || {};
      const price = (bp.price != null && !isNaN(bp.price)) ? bp.price : (meta.lastPx || 0);
      rows.push({
        d: bestand.date, isin: wkn, name: meta.name || bp.name || wkn,
        typ: meta.typ || "Fonds",
        tx: resid > 0 ? "Einbuchung" : "Ausbuchung",
        preis: fmt(price), anzahl: fmt(Math.abs(resid)),
        geb: "0", st: "0", ccy: "EUR", wk: "1,00",
        _bal: true
      });
      balAdds.push({ wkn, name: meta.name || bp.name || wkn, resid, have, want });
      if(!positions[wkn]) positions[wkn] = { name: bp.name || wkn, typ: "Fonds", qty: 0 };
      positions[wkn].qty += resid;                         // reflect reconciled qty in the table
    }
  }

  /* ---- banners + note tables (display data) ---- */
  const cell = (t, n) => n ? { t, num: true } : (t == null ? "" : "" + t);
  const banners = [{ kind: "warn", parts: [
    { b: "GenoBroker liefert nur WKNs" },
    " (keine ISIN). Die WKN steht daher in der ISIN-Spalte – prüfe nach dem Import, ob ExtraETF alle Wertpapiere erkannt hat, und ersetze die WKN sonst in der CSV durch die ISIN."] }];
  banners.push(bestand
    ? { kind: "good", parts: [{ b: "✅ Bestand-Abgleich" }, balAdds.length
        ? ` — ${balAdds.length} Ausgleichsbuchung(en) zum ${bestand.date} ergänzt, damit die Positionen exakt dem GenoBroker-Depotbestand entsprechen (Rundung der Umsatzanzeige auf 2 Nachkommastellen / fehlende Historie).`
        : ` — alle Positionen stimmen exakt mit dem GenoBroker-Depotbestand (${bestand.date}) überein.`] }
    : { kind: "warn", parts: [{ b: "Tipp:" }, " Lade zusätzlich den GenoBroker-", { b: "Depotbestand" },
        " (", { b: "Depotbestand_….csv" }, ") hoch – dann gleicht der Konverter die Positionen exakt ab (die Umsatzanzeige rundet Stückzahlen auf 2 Nachkommastellen)."] });
  if(dups) banners.push({ kind: "good", parts: [
    { b: `${dups} doppelte Buchung(en)` },
    " aus überlappenden Umsatz-Exporten erkannt und übersprungen (gleiche Auftrags-Nr.)."] });

  const notes = [];
  if(balAdds.length) notes.push({
    title: "Bestand-Ausgleichsbuchungen",
    cols: ["WKN", "Name", "Buchung", { t: "Stück", num: true }, { t: "rekonstr.→Ziel", num: true }],
    rows: balAdds.map(b => [cell(b.wkn), cell(b.name), cell(b.resid > 0 ? "Einbuchung" : "Ausbuchung"),
      cell(fmt(Math.abs(b.resid)), true), cell(`${fmt(b.have)} → ${fmt(b.want)}`, true)])
  });
  if(vorab.length) notes.push({
    title: "Vorabpauschale – nicht per CSV importierbar, manuell als Steuer erfassen",
    cols: ["Datum", "Name", "WKN", { t: "Steuer (EUR)", num: true }],
    rows: vorab.map(v => [cell(v.date), cell(v.name), cell(v.wkn), cell(fmt(v.tax), true)])
  });
  if(skipped.length) notes.push({
    title: "Übersprungen (unbekannte Geschäftsart / fehlende Werte)",
    cols: ["Datum", "Name", "WKN", "Geschäftsart"],
    rows: skipped.map(s => [cell(s.date), cell(s.name), cell(s.wkn), cell(s.ga)])
  });

  return {
    rows, positions, cashSummary, cashOrder: [VORAB_LABEL],
    banners, notes,
    stats: bestand ? [["Bestand-Abgleich", balAdds.length]] : []
  };
}

/* ============================ registration ============================ */
X.register({
  id: "geno",
  label: "GenoBroker",
  kindLabels: { umsaetze: "GenoBroker", bestand: "Bestand" },
  detect(text, name){
    const geno = /GENO\s*Broker|GENODEFF/i.test(text) || /^Depot(umsaetze|bestand)_/i.test(name || "");
    if(!geno) return null;
    if(/Depotbestand/i.test(text) || /^Depotbestand_/i.test(name || "")) return "bestand";
    if(/Depotumsatzanzeige|Depotumsaetze/i.test(text) || /^Depotumsaetze_/i.test(name || "")) return "umsaetze";
    return null;
  },
  convert
});

})();
