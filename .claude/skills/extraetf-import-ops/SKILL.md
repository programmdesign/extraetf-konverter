---
name: extraetf-import-ops
description: >-
  Operate the ExtraETF web app (app.extraetf.com) via browser automation to fix/test/adjust
  CapTrader→ExtraETF imports and book, edit or delete transactions. Use when booking manual
  cash or securities transactions, deleting/editing transactions, running a CSV import,
  reconciling a portfolio's Verrechnungskonto (clearing account) to a target balance,
  diagnosing why an import looks wrong (currency/split/price), or working on
  captrader-to-extraetf.html. Encodes exact selectors, field IDs, click sequences,
  known ExtraETF bugs and Playwright gotchas so the work goes fast.
---

# ExtraETF import operations (CapTrader → ExtraETF)

A field-tested playbook for driving the ExtraETF web app to fix/test CapTrader imports, book &
delete transactions, run CSV imports, reconcile cash, and work around ExtraETF's import quirks.
Everything here was verified end-to-end while reconciling a real portfolio to the broker's NAV.

## Ground rules
- **Only touch the portfolio you were told to.** Confirm before each mutating action unless the
  user has clearly said "go" / "execute".
- A fresh Playwright browser has no ExtraETF session. The persistent MCP Chrome profile usually
  keeps the login across relaunches; if it's **locked by a stale Chrome** ("Browser is already in
  use … use --isolated"), ask the user to close that window, then relaunch (session persists).
- **Do not read the auth JWT from localStorage/sessionStorage to call the backend API directly** —
  the safety classifier blocks it as credential exploration. Always use the UI. (Backend is
  `wealthapi.eu/api/v1`, Bearer-authed; useful to know for reading network requests, not for POSTing.)

## App map
- `/de/accounts` — portfolio & Verrechnungskonto cards. Settings: card's ⋮ menu → **"Portfolio bearbeiten"**.
- `/de/transactions` — transaction list. **Two tabs: "Wertpapier" (securities) and "Cash"** (`?tab=cash-transactions`).
  Cash bookings (Gutschrift/Abbuchung/Zinsen-Gebühren) appear ONLY on the Cash tab; the Wertpapier tab
  is Kauf/Verkauf/Dividende/Einbuchung/Ausbuchung/Split.
- `/de/investments` — positions with live market values. `/de/dividends` — dividends.
- **Scope to one depot** by appending `?view=depot_<depotId>` to the URL — do this so the "+" dialog and
  filters default to the right portfolio.
- **Filter to one security** with the "Wertpapier" filter → adds `?investmentId=<id>` (shows all of that
  security's transactions regardless of date).
- A portfolio has **two account ids**: a depot/securities id and a separate cash-account id
  (they differ by a small amount, e.g. `…257` depot / `…258` cash). Cash transactions POST against the cash id.

## Booking a transaction — the "+" dialog
The blue **"+"** in the top bar = `button[name="Neue Aktivität"]`. On pages that render two (header +
main), use `app-header button[name="Neue Aktivität"]`. The dialog:
- Tabs: **Wertpapiere · Edelmetalle · Krypto · Cash · Immobilien**. It **reopens on Wertpapiere every time**
  and **closes after each Speichern** (so reopen per entry).
- The **Cash tab** is `button:text-is("Cash")` and needs a **real click** (synthetic `.click()` won't switch it).

**Cash form** (after switching to the Cash tab):
- TYP dropdown values: **Gutschrift (+)**, **Abbuchung (−)**, **Zinsen/Gebühren** (signed net: positive = credit,
  negative = debit; also shows a Steuern field), **Steuererstattung**, **Dividenden**.
- Fields: `#inp_tx_date` (native `<input type=date>` — set ISO `YYYY-MM-DD`), `#inp_tx_amount` (Betrag),
  `#inp_tx_comment` (Kommentar, revealed under **"Mehr Optionen"**).
- **`#inp_tx_amount` is a masked Angular field → type it with real keystrokes** (`browser_type` / pressSequentially),
  **German comma decimals** (`8528,61`); it accepts a leading `-` (Zinsen/Gebühren debit). Native value-set
  works only to *clear* it (`""`) before typing.
- **Date & comment**: native-setter + `input`/`change` events work reliably.

**Securities form** (Wertpapiere tab): search `#inp_investment_search` (type ISIN) → click the result →
TYP (Kauf/Verkauf/Dividende/Einbuchung/Ausbuchung) → `#inp_booking_date`, `#inp_booking_number_of_lots`
(Anzahl), `#inp_booking_entry_quote` (Kurs), `#inp_booking_amount` (auto = Anzahl×Kurs), `#inp_booking_commission`,
`#inp_booking_tax_amount`, `#inp_booking_comment`. Currency selector next to Kurs/Betrag defaults to €.

**Efficient per-entry routine (cash):** `[+]` → click Cash tab → one `browser_evaluate` that (if needed)
selects the TYP (click the trigger `button` showing the current type, then the matching `.dropdown-item`),
sets `#inp_tx_date`, sets `#inp_tx_comment`, and clears `#inp_tx_amount` → `browser_type` the amount →
click **Speichern** (`button:text-is("Speichern")`). Read TYP/date/comment back before saving; verify the
Verrechnungskonto after (on `/de/accounts`, the cash value is drift-free).

## Deleting a transaction
Make the row visible (see "finding a row") → click the row's **⋮ action button** → **"Löschen"**
(`.dropdown-item:has-text("Löschen")`) → confirm **"Löschen"** in the `#cdk-dialog-*` confirm modal
("Transaktion löschen? … kann nicht rückgängig gemacht werden"). Not undoable except by re-creating —
note the exact values first.

## Finding a row in a long (virtualized) list
The list is date-sorted desc and only ~100 rows load. To surface a specific one:
- **Wertpapier filter** → pick the security (adds `?investmentId=`) — shows all its txns.
- **Transaktionstyp filter** (Kauf/Verkauf/Dividende/…) **plus set the time range to "Max"** (default "1 Jahr" hides older years).
- Or click the **Betrag** column header to sort by amount (surfaces large deposits/plugs at the top).

## CSV import
Top-bar **Datenimport** = `button[name="Datenimport"]` (svg path starts `M14 3C12.8954…`). The **adjacent
`M13.6119…` icon is CSV EXPORT — do not click it** (it downloads a file). → **"CSV importieren"** → depot is
auto-selected from the current view → **"Datei auswählen"** (opens a file chooser → `browser_file_upload`
with the absolute path) → preview → **Speichern**.
CSV import is the **only** way to create Einbuchungen / positions for corp-action-locked securities (below).

## Portfolio settings — accounts card ⋮ → "Portfolio bearbeiten"
- **"Berücksichtigen"** (checkbox) — include the Verrechnungskonto in the portfolio total. Keep ON for full NAV.
- **"Negative Kontostände ausgleichen"** — auto-tops-up negative cash. ON *hides* the true clearing balance;
  turn **OFF** for a transparent, real Verrechnungskonto (it will swing to a large negative mid-reconciliation —
  that's expected; the documented flows bring it back).
- On the card itself, the small icon next to the Verrechnungskonto value is an **include/exclude toggle** —
  clicking it changes the card total. Don't click it by accident; leave the setting to the edit dialog.

## Reconciling the Verrechnungskonto to a target (e.g. the broker's Endbarsaldo)
1. Turn OFF "Negative Kontostände ausgleichen".
2. Delete any opaque "plug" cash entries.
3. Book the **documented** non-importable cash flows as labelled entries (deposits/withdrawals as
   Gutschrift/Abbuchung; interest/withholding-tax/fees/accrued-interest as Zinsen/Gebühren, signed).
   Cash is NOT CSV-importable — book via the "+" Cash form. Split by year (or per actual movement) if asked.
4. Measure the leftover and book **one honest balancer** ("FX-Kursbewertung + Rundung") so the Verrechnungskonto
   equals the target to the cent. Book known one-offs (e.g. a corp-action cash correction) as their own labelled entries.

## Known ExtraETF bugs (converter/CSV are correct — report these to ExtraETF)
- **Split with ISIN change** (example: Kongsberg `NO0003043309` → `NO0013536151`, 5:1). ExtraETF auto-inserts
  an **un-deletable "Split" transaction** on the new ISIN and values the post-split quantity at the **pre-split
  price** (position badly inflated). Worse: **manual Kauf/Einbuchung on such a security silently fails to persist**
  (dialog closes, no transaction, cash unchanged) and the dialog **locks TYP to "Kauf"**. To create/restore the
  holding, use **CSV import** of an `Einbuchung` row (this is what persists).
- **Foreign-currency dividends**: ExtraETF's CSV import **ignores the `Wechselkurs` for `Dividende`** and books
  the native `Preis`/`Steuern` **as EUR** (e.g. `318 HKD` → `318 €`, ~9× too high; NOK/SEK similar; USD≈EUR so
  barely visible; GBP under-books). `Kauf`/`Verkauf` convert correctly — only `Dividende` is broken. Workaround:
  pre-convert foreign dividends to EUR in the CSV (`Preis`/`Steuern` in EUR, `Währung=EUR`), or file the bug.
  A minimal repro CSV: 2-3 `Dividende` rows with a non-EUR `Währung` + correct `Wechselkurs`.

## Playwright gotchas (learned the hard way)
- Dropdown options are `button[role=menuitem].dropdown-item`. Evaluate-clicking option *text* can land on the
  background table — prefer a real `browser_click` on a ref, or a scoped selector, and **verify the state changed**.
- Angular **masked number inputs** (amount, Anzahl, Kurs) need **real keystrokes**; date & comment accept
  native-setter + `input`/`change`.
- A **lingering modal/edit dialog** leaves a backdrop (`.cdk-overlay-backdrop` / a `fixed inset-0` div) that
  **intercepts clicks** → "element intercepts pointer events". Escape/close it or navigate fresh before continuing.
- **Tabs** (the Cash tab, dialog tabs) need a real click via `button:text-is("…")`, not synthetic `.click()`.
- After deletes/edits, ExtraETF recomputes positions **asynchronously** — re-read (or navigate fresh) before trusting.
- The `[active]` flag in an accessibility snapshot often just means *focused*, not *toggled*.

## The converter (`captrader-to-extraetf.html`)
Client-side, dependency-free: `captrader-to-extraetf.html` + `styles.css` + `converter.js` (an IIFE module).
**Do not change the conversion logic without re-testing against the Bestand**: serve with
`python3 -m http.server` (file:// is blocked), open the page, upload the real trade + cash + Bestand CSVs,
and confirm the positions reconcile (0 balancing entries, or only the known corporate actions).
Output spec: `Datum;ISIN;Name;Typ;Transaktion;Preis;Anzahl;Gebühren;Steuern;Währung;Wechselkurs` —
semicolon-separated, German decimals, `TT.MM.JJJJ`; `Wechselkurs` = **foreign units per 1 EUR** (= 1 / IB
`FXRateToBase`), so **EUR amount = Preis ÷ Wechselkurs**. Cash flows and bond coupons are NOT written to the
CSV (ExtraETF has no working Kupon type) — they're summarised for manual entry.
