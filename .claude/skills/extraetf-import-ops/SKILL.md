---
name: extraetf-import-ops
description: >-
  Operate the ExtraETF web app (app.extraetf.com) to fix/test/adjust CapTrader→ExtraETF imports and
  book, edit or delete transactions. Use for manual cash or securities bookings, deletions, CSV imports,
  reconciling a portfolio's Verrechnungskonto to a target balance, diagnosing why an import looks wrong
  (currency/split/price), or working on captrader-to-extraetf.html. Leads with durable technique;
  exact selectors, field IDs and step-by-step flows live in reference.md.
---

# ExtraETF import operations (CapTrader → ExtraETF)

How to drive the ExtraETF web app fast and safely for CapTrader-import work. **Selectors verified
2026-07 against a live Angular SPA — treat every ID/selector as a point-in-time hint: snapshot and
verify before relying on it, and re-derive if the UI has changed.** Exhaustive selectors, field IDs and
click-by-click flows are in **`reference.md`** (read it when you need them; this file is the durable part).

⚠️ Not affiliated with / endorsed by ExtraETF, CapTrader or Interactive Brokers. Use at your own risk.

## Ground rules
- **Only touch the portfolio you were told to.** Confirm before each mutating action unless the user said "go".
- A fresh Playwright browser has no ExtraETF session; the user logs in first. The persistent MCP Chrome
  profile usually keeps the login across relaunches; if it's **locked by a stale Chrome**, ask the user to
  close that window, then relaunch.
- **Do not read the auth JWT from local/session storage to call the backend API directly** — the safety
  classifier blocks it as credential exploration. Always drive the UI.

## Method first — this survives UI changes; the selectors don't
1. **Scope by URL:** open `/de/transactions?view=depot_<depotId>` (and friends) so the "+" dialog and filters
   default to the right portfolio. Filter to one security → `?investmentId=<id>`.
2. **snapshot → verify → act → re-check.** Get a fresh element ref from a snapshot, act on it, then verify the
   *effect* — read the field back before saving, and re-read the **Verrechnungskonto on `/de/accounts`** (a
   drift-free cash figure) after. Never trust that a click "worked" — confirm state changed.
3. **Masked number inputs** (amount, Anzahl, Kurs) need **real keystrokes** (`browser_type`/pressSequentially),
   **German comma decimals** (`8528,61`), and accept a leading `-`. Native value-set only works to *clear* them.
   **Dates & comments** take native-setter + `input`/`change` events.
4. **Tabs** (the Cash tab, dialog tabs) need a **real click** (`button:text-is("…")`) — a synthetic `.click()` won't switch them.
5. A **leftover modal leaves a backdrop** (`.cdk-overlay-backdrop` / a `fixed inset-0` div) that intercepts
   clicks ("element intercepts pointer events") → Escape/close it or navigate fresh.
6. After deletes/edits ExtraETF **recomputes positions asynchronously** — re-read (or navigate fresh) before trusting.
7. `[active]` in an a11y snapshot usually just means *focused*, not *toggled*.

## Reusable snippets
```js
// Native-set a value — works for the date input and the comment textarea (NOT the masked amount fields).
const set = (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};

// In the "+" → Cash dialog: pick a TYP (the trigger button shows the current type), set date + comment,
// and clear the amount — then browser_type the amount separately with REAL keystrokes, then Speichern.
const trig = [...document.querySelectorAll('button')].find(b => /^(Gutschrift|Abbuchung|Zinsen)/i.test((b.innerText||'').trim()) && b.offsetParent);
trig?.click();
[...document.querySelectorAll('.dropdown-item')].find(o => /^Zinsen\/Geb/i.test(o.innerText||''))?.click(); // desired TYP
[...document.querySelectorAll('button,a')].find(b => /Mehr Optionen/i.test(b.innerText||'') && b.offsetParent)?.click();
set(document.getElementById('inp_tx_date'), '2025-12-31');
set(document.getElementById('inp_tx_comment'), 'Broker-Zinsen (netto) 2025');
set(document.getElementById('inp_tx_amount'), '');   // clear, then browser_type the real value
```
Cash form field IDs: `#inp_tx_date`, `#inp_tx_amount`, `#inp_tx_comment`. Securities form:
`#inp_investment_search`, `#inp_booking_date`, `#inp_booking_number_of_lots`, `#inp_booking_entry_quote`,
`#inp_booking_amount`, `#inp_booking_commission`, `#inp_booking_tax_amount`, `#inp_booking_comment`.

## Core workflows (click-by-click in reference.md)
Book a cash entry · book a securities transaction · delete a transaction · CSV import · edit portfolio
settings · find a row in the virtualized list · reconcile the Verrechnungskonto to a target.

## Known ExtraETF bugs — report to ExtraETF; the converter/CSV are correct
- **Foreign-currency dividends:** the CSV import **ignores the `Wechselkurs` for `Dividende`** and books the
  native `Preis`/`Steuern` **as EUR** (e.g. `318 HKD` → `318 €`, ~9× high; USD≈EUR barely shows). Kauf/Verkauf
  convert fine — only Dividende is broken. Workaround: pre-convert to EUR (`Währung=EUR`). *[verified: opened
  the stored transaction — currency was EUR, no Wechselkurs.]*
- **Split with ISIN change** (e.g. 5:1, new ISIN): position shown at the **pre-split price** (inflated) because the
  corporate action **leaves the investment with no Börsenplatz** → no current quote is pulled (the price-freshness
  dot is **red** with a pre-split timestamp; hover shows source + time). **Fix the price: edit the investment
  (⋮ → „Bearbeiten") and set a Börsenplatz** (e.g. Stuttgart). Quantity is separate: an auto-"Split" is un-deletable
  and manual Kauf/Einbuchung don't persist (TYP locked to "Kauf") → (re)create the holding via **CSV import** of an
  `Einbuchung` row. *[Börsenplatz price fix reported by user 2026-07; glitch + persistence previously verified on-screen.]*

## The converter (`captrader-to-extraetf.html`)
Client-side, no deps: `captrader-to-extraetf.html` + `styles.css` + `converter.js` (IIFE module; rendering uses
`<template>` clone-and-fill, no HTML strings). **Don't change the conversion logic without re-testing against
the Bestand**: `python3 -m http.server` (file:// is blocked), upload the real trade + cash + Bestand CSVs, confirm
positions reconcile. CSV spec: `Datum;ISIN;Name;Typ;Transaktion;Preis;Anzahl;Gebühren;Steuern;Währung;Wechselkurs`
— semicolon, German decimals, `TT.MM.JJJJ`; `Wechselkurs` = foreign units per 1 EUR (= 1/IB `FXRateToBase`), so
**EUR amount = Preis ÷ Wechselkurs**. Cash flows and bond coupons are not written to the CSV (no working Kupon type).
