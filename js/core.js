"use strict";
/* ============================================================================
   Shared core: CSV parsing, formatting, ExtraETF output spec, converter registry.
   ---------------------------------------------------------------------------
   ExtraETF import spec (confirmed via support.extraetf.com, article 4744749535634):
     Datum;ISIN;Name;Typ;Transaktion;Preis;Anzahl;Gebühren;Steuern;Währung;Wechselkurs
     · Separator ';'  · German decimals (comma)  · Date TT.MM.JJJJ
     · Typ        ∈ Aktie, ETF, Fonds, Anleihe, Zertifikat/OS, Edelmetall, Fremdwährung
     · Transaktion∈ Kauf, Verkauf, Dividende, Kupon, Einbuchung, Ausbuchung
     · Preis      = execution price; Dividende → GROSS amount; Anleihe → Kurs in %
     · Anzahl     = shares; Dividende → 1; Anleihe → nominal value
     · Gebühren / Steuern = positive values (no minus sign)
     · Wechselkurs= foreign units per 1 EUR when not EUR, else 1,00

   Converter contract — each bank module calls ExtraETF.register({
     id          : short slug, also used as file-badge CSS class ("captrader", "geno")
     label       : display name ("CapTrader", "GenoBroker")
     kindLabels  : { fileKind: badge text }
     detect(text, fileName) → fileKind string | null (null = not this bank's file)
     convert(files)         → {
       rows        : [{d,isin,name,typ,tx,preis,anzahl,geb,st,ccy,wk,_bal?}]  (formatted strings)
       positions   : { isinOrWkn: {name, typ, qty} }
       cashSummary : { displayLabel: {ccy: {CUR: amount}} }   (manual bookings, not CSV-importable)
       cashOrder   : [displayLabel …]                          (render order, optional)
       banners     : [{kind:"good"|"warn", parts:[string|{b:string}]}]         (top area)
       notes       : [{title, cols:[string|{t,num}], rows:[[string|{t,num}]]}  (collapsible tables)
                      |{banner:{kind,parts}}]                                  (…or inline banner)
       stats       : [[label, value]]                          (extra summary cards, optional)
     }
   ============================================================================ */

(function () {

const ExtraETF = {};

/* ----------------------------- CSV parsing ----------------------------- */
/** Minimal RFC-4180-style parser → array of string rows. Handles quotes, CRLF, BOM.
    delim: field separator, default ',' (CapTrader); GenoBroker uses ';'. */
ExtraETF.parseCSV = function parseCSV(text, delim){
  delim = delim || ",";
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], field = "", quoted = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(quoted){
      if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else quoted = false; }
      else field += c;
    } else {
      if(c === '"') quoted = true;
      else if(c === delim) { row.push(field); field = ""; }
      else if(c === "\n"){ row.push(field); rows.push(row); row = []; field = ""; }
      else if(c === "\r"){ /* ignore */ }
      else field += c;
    }
  }
  if(field !== "" || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ""));
};

/* ----------------------------- number / date helpers ----------------------------- */
/** Parse a numeric string using '.' as decimal separator (CapTrader / IB format). */
ExtraETF.num = s => { if(s == null) return NaN; s = ("" + s).trim(); return s === "" ? NaN : parseFloat(s); };

/** Parse a German numeric string: '.' thousands, ',' decimal ("1.820,30" → 1820.3). */
ExtraETF.numDE = s => {
  if(s == null) return NaN;
  s = ("" + s).trim();
  if(s === "" || s === "-") return NaN;
  return parseFloat(s.replace(/\./g, "").replace(",", "."));
};

/** Number → German string (comma decimal, no thousands separator, ≤6 dp, trimmed). */
ExtraETF.fmt = function fmt(x){
  if(x === "" || x == null || (typeof x === "number" && isNaN(x))) return "";
  const n = typeof x === "number" ? x : parseFloat(x);
  if(isNaN(n)) return "";
  let s = (Math.round(n * 1e6) / 1e6).toString();
  if(s.indexOf("e") > -1) s = n.toFixed(6);
  return s.replace(".", ",");
};

/** 'DD/MM/YYYY[ HH:MM:SS]' (or ISO) → 'DD.MM.YYYY'. */
ExtraETF.deDate = function deDate(s){
  if(!s) return "";
  const d = ("" + s).trim().split(/[ T]/)[0];
  let m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if(m) return `${m[1]}.${m[2]}.${m[3]}`;
  m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m) return `${m[3]}.${m[2]}.${m[1]}`;
  return d;
};

/** Sort key: 'DD.MM.YYYY' → 'YYYYMMDD' (balancing rows sort last via '9' prefix). */
ExtraETF.sortKey = r => (r._bal ? "9" : "0") + (("" + (r.d || "")).split(".").reverse().join(""));

ExtraETF.ISIN_RE = /\(([A-Z]{2}[A-Z0-9]{9}\d)\)/;              // ISIN embedded in "(...)"
ExtraETF.isISIN  = s => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s || "");
ExtraETF.norm    = s => ("" + s).replace(/\s+/g, " ").trim().toUpperCase();

/* ------------------- security type hint (ExtraETF re-detects by ISIN) ------------------- */
ExtraETF.ETF_WORDS = /\b(ETF|ETP|ETN|UCITS|ISHARES|XTRACKERS|X TRACKERS|AMUNDI|LYXOR|VANECK|VAN ECK|INVESCO|SPDR|WISDOMTREE|FRANKLIN|FRK|HANETF|GLOBAL X|21SHARES|COINSHARES|BITWISE|VANGUARD|SWAP)\b/;

/* ----------------------------- ExtraETF CSV output ----------------------------- */
ExtraETF.HEADER = ["Datum","ISIN","Name","Typ","Transaktion","Preis","Anzahl","Gebühren","Steuern","Währung","Wechselkurs"];
ExtraETF.toCSV = function toCSV(rows){
  const esc = v => { v = (v == null ? "" : "" + v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; };
  const lines = [ExtraETF.HEADER.join(";")];
  for(const r of rows) lines.push([r.d,r.isin,r.name,r.typ,r.tx,r.preis,r.anzahl,r.geb,r.st,r.ccy,r.wk].map(esc).join(";"));
  return lines.join("\r\n");
};

/* ----------------------------- converter registry ----------------------------- */
ExtraETF.converters = [];
ExtraETF.register = c => { ExtraETF.converters.push(c); };
/** First converter whose detect() claims the file wins. → {conv, kind} | null */
ExtraETF.detect = (text, name) => {
  for(const conv of ExtraETF.converters){
    const kind = conv.detect(text, name);
    if(kind) return { conv, kind };
  }
  return null;
};

globalThis.ExtraETF = ExtraETF;   // browser + node (tests)
})();
