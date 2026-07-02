# ExtraETF UI reference (companion to SKILL.md)

Exhaustive selectors, field IDs and click-by-click flows for app.extraetf.com. **Verified 2026-07 against a
live Angular SPA — point-in-time. Snapshot and verify each element before relying on it; re-derive if changed.**
Read `SKILL.md` first for the ground rules and durable method.

## App map
- `/de/accounts` — portfolio & Verrechnungskonto cards. Card ⋮ menu → **"Portfolio bearbeiten"** for settings.
- `/de/transactions` — transaction list. **Two tabs: "Wertpapier" (securities) and "Cash"** (`?tab=cash-transactions`).
  Cash bookings (Gutschrift/Abbuchung/Zinsen-Gebühren) appear ONLY on the Cash tab; the Wertpapier tab holds
  Kauf/Verkauf/Dividende/Einbuchung/Ausbuchung/Split.
- `/de/investments` — positions with live market values. `/de/dividends` — dividends.
- **Scope to one depot:** append `?view=depot_<depotId>` to the URL.
- **Filter to one security:** the "Wertpapier" filter → adds `?investmentId=<id>` (shows all its txns, any date).
- A portfolio has **two account ids**: a depot/securities id and a separate cash-account id (they differ by a
  small amount, e.g. `…257` depot / `…258` cash). Cash transactions belong to the cash id.

## Field IDs
**Cash form** (the "+" → Cash tab): `#inp_tx_date` (native `type=date`, set ISO `YYYY-MM-DD`),
`#inp_tx_amount` (Betrag — masked; set via `browser_type`/`.fill()` + Enter to submit, NOT native JS value-set), `#inp_tx_comment` (Kommentar, under "Mehr Optionen").
**Securities form** (Wertpapier tab): `#inp_investment_search`, `#inp_booking_date`,
`#inp_booking_number_of_lots` (Anzahl), `#inp_booking_entry_quote` (Kurs), `#inp_booking_amount` (auto),
`#inp_booking_commission`, `#inp_booking_tax_amount`, `#inp_booking_comment`.

## Toolbar buttons (top bar)
- **"+" Neue Aktivität** = `button[name="Neue Aktivität"]` (svg path `M16 4V28M28 16L4 16`). On pages with two,
  use `app-header button[name="Neue Aktivität"]`.
- **Datenimport** = `button[name="Datenimport"]` (svg path `M14 3C12.8954…`). The **adjacent `M13.6119…` icon is
  CSV EXPORT — do not click it** (it downloads a file). Then "Portfolio teilen", then "Privacy Mode".

## Dropdowns & dialogs
- Dropdown options = `button[role=menuitem].dropdown-item`. Prefer clicking a snapshot **ref**; if using a
  selector, scope it and verify state changed (evaluate-clicking option *text* can land on the table behind).
- Delete-confirm modal = `#cdk-dialog-*` containing "Transaktion löschen? … kann nicht rückgängig gemacht werden".
- Modal close (X) = `[data-testid="modal_close_button"]`.

## Booking a cash entry
`[+]` (`button[name="Neue Aktivität"]`) opens the dialog on **Wertpapiere**; it closes after each Speichern, so every
booking reopens it. TYP values: **Gutschrift (+)**, **Abbuchung (−)**, **Zinsen/Gebühren** (signed net: positive
credit, negative debit; adds a Steuern field), **Steuererstattung**, **Dividenden**.

**Fast path — ~2 tool calls/booking (verified 2026-07 over a 28-entry batch):**
1. **One `browser_evaluate`** (snippet below): fire `+` → wait for `.cdk-overlay-container` → **switch to Cash with a
   *synthetic* click on the tab _inside the overlay_** (bbox y≈210–330). There are two "Cash" elements — the page's
   own Cash tab is a no-op, which is why a naive synthetic click appears to "not switch". Then wait for
   `#inp_tx_amount` → set TYP (fire the trigger `button`, then the matching `.dropdown-item`) → expand "Mehr
   Optionen" → native-set `#inp_tx_date` (ISO) + `#inp_tx_comment` → clear + focus `#inp_tx_amount`. **Return the
   resolved TYP/date so you can verify before typing** — a wrong TYP silently flips the sign on Abbuchung/Zinsen.
2. **`browser_type` `#inp_tx_amount` = amount, `submit:true`** — Enter saves & closes (or click
   `button:text-is("Speichern")`). `browser_type`'s default `.fill()` DOES register on the masked field (formats to
   e.g. `25.000`); no `slowly`/pressSequentially needed. German comma decimals (`262,57`); enter the POSITIVE amount
   for Abbuchung (the TYP carries the −); a leading `-` is allowed for a negative Zinsen/Gebühren net.
3. Per batch/year, re-read the drift-free **Verrechnungskonto on `/de/accounts`** and confirm it moved by the sum booked.

_Refines SKILL.md ground-rule #4:_ the **dialog** Cash tab **does** switch via synthetic click (target the overlay
tab), and the masked amount registers via `browser_type`/`.fill()` — only the *page* Cash tab and *native JS*
value-set fail. Fallback if the synthetic tab click ever stops working: `browser_click` `button:text-is("Cash")`
scoped to the overlay, then a second evaluate for TYP/date/comment.

```js
// One evaluate: open dialog + Cash tab + TYP/date/comment + focus amount. Then browser_type the amount (submit:true).
async () => {
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const waitFor=async(fn,t=4500)=>{const s=Date.now();while(Date.now()-s<t){const el=fn();if(el)return el;await sleep(70);}return null;};
  const fire=el=>{for(const t of ['pointerdown','mousedown','mouseup','click'])el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));};
  const set=(el,v)=>{const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
  const DATE='2024-05-30', CMT='Auszahlung', TYP=/^Abbuchung/;   // ← per booking; TYP ∈ /^Gutschrift/ | /^Abbuchung/ | /^Zinsen/
  fire(document.querySelector('app-header button[name="Neue Aktivität"]')||document.querySelector('button[name="Neue Aktivität"]'));
  const ov=await waitFor(()=>document.querySelector('.cdk-overlay-container'));
  const tab=await waitFor(()=>[...(ov||document).querySelectorAll('a,button,div,span')].filter(e=>e.children.length===0&&(e.textContent||'').trim()==='Cash'&&e.offsetParent).find(e=>{const r=e.getBoundingClientRect();return r.y>210&&r.y<330;}));
  if(!tab)return{err:'no dialog cash tab'}; fire(tab);
  const amt=await waitFor(()=>document.getElementById('inp_tx_amount'),2500); if(!amt)return{err:'cash form not shown'};
  const trig=[...document.querySelectorAll('button')].find(b=>/^(Gutschrift|Abbuchung|Zinsen)/i.test((b.innerText||'').trim())&&b.offsetParent); if(trig)fire(trig); await sleep(200);
  const opt=[...document.querySelectorAll('.dropdown-item,[role=menuitem],button,a')].find(o=>TYP.test((o.innerText||'').trim())&&o.offsetParent); if(opt)fire(opt); await sleep(120);
  const mehr=[...document.querySelectorAll('button,a')].find(b=>/Mehr Optionen/i.test(b.innerText||'')&&b.offsetParent); if(mehr)fire(mehr); await sleep(120);
  const d=document.getElementById('inp_tx_date'); if(d)set(d,DATE);
  const c=document.getElementById('inp_tx_comment'); if(c)set(c,CMT);
  set(amt,''); amt.focus();
  const t2=[...document.querySelectorAll('button')].find(b=>/^(Gutschrift|Abbuchung|Zinsen)/i.test((b.innerText||'').trim())&&b.offsetParent);
  return {ok:true, typ:t2&&t2.innerText.trim().split('\n')[0], date:d&&d.value, comment:c&&c.value};
}
```

## Booking a securities transaction
`[+]` → (Wertpapiere tab is default) → type ISIN into `#inp_investment_search` → click the matching result
(`… <ISIN> · Aktie`) → set TYP → set `#inp_booking_date` (native), type `#inp_booking_number_of_lots` and
`#inp_booking_entry_quote` (Betrag auto-computes) → Speichern. Currency selector next to Kurs defaults to €.
(For a corp-action-locked security this silently fails — see bugs.)

## Deleting a transaction
Make the row visible (see "finding a row") → row's **⋮ action button** → **"Löschen"**
(`.dropdown-item:has-text("Löschen")`) → confirm **"Löschen"** in the `#cdk-dialog-*` modal. Not undoable except
by re-creating — record the exact values first. (When targeting by amount, sort by Betrag first so the intended
row is unambiguous.)

## Finding a row in the virtualized list
Only ~100 rows load, date-sorted desc. Surface a specific one via: the **Wertpapier filter** (one security),
the **Transaktionstyp filter** **+ set the time range to "Max"** (default "1 Jahr" hides older years), or click the
**Betrag column header** to sort by amount.

## CSV import
**Datenimport** (`button[name="Datenimport"]`) → **"CSV importieren"** → depot auto-selected from the view →
**"Datei auswählen"** (opens a file chooser → `browser_file_upload` with the absolute path) → preview → **Speichern**.
This is the only way to create Einbuchungen / positions for corp-action-locked securities.

## Portfolio settings — accounts card ⋮ → "Portfolio bearbeiten"
- **"Berücksichtigen"** (checkbox) — include the Verrechnungskonto in the total. Keep ON for full NAV.
- **"Negative Kontostände ausgleichen"** — auto-tops-up negative cash. ON hides the true clearing balance; turn
  **OFF** for a transparent, real Verrechnungskonto (it will swing to a large negative mid-reconciliation — expected).
- On the card, the icon next to the Verrechnungskonto value is an **include/exclude toggle** — don't click it by
  accident (it changes the card total). Use the edit dialog for the setting.

## Reconciling the Verrechnungskonto to a target
1. Turn OFF "Negative Kontostände ausgleichen".
2. Delete opaque "plug" cash entries.
3. Book the documented non-importable flows as labelled Cash entries (deposits/withdrawals = Gutschrift/Abbuchung;
   interest/withholding-tax/fees/accrued-interest = Zinsen/Gebühren, signed). Split by year or per actual movement if asked.
4. Measure the leftover and book one honest **"FX-Kursbewertung + Rundung"** balancer so the Verrechnungskonto
   equals the target to the cent. Book known one-offs (e.g. a corporate-action cash correction) as their own labelled entries.

## Known ExtraETF bugs — detail
### Foreign-currency dividends booked as EUR *(verified)*
CSV import ignores the `Wechselkurs` for `Transaktion=Dividende` and stores the native `Preis`/`Steuern` as EUR.
Observed by opening the stored Tencent dividend (`KYG875721634`): `Preis=318`, currency **€**, no Wechselkurs —
the CSV row was correct (`Preis=318;…;Währung=HKD;Wechselkurs=9,11577` → should be ≈ 34,88 €). `Kauf`/`Verkauf`
convert correctly, so it is specific to `Dividende`. Impact scales with the rate: HKD/NOK/SEK ~9–11× too high,
USD ≈ EUR (barely visible), GBP slightly under. Workaround: pre-convert those dividends to EUR in the CSV
(`Preis`/`Steuern` in EUR, `Währung=EUR`), or file the bug (a 2-3 row `Dividende` CSV in a foreign currency reproduces it).

### Split with ISIN change *(price fix reported by user; glitch/persistence verified)*
Example: Kongsberg `NO0003043309` → `NO0013536151` (5:1). ExtraETF auto-inserts an **un-deletable "Split 1:5"**
on the new ISIN and initially values the post-split quantity at the **pre-split price** (position inflated).
**Root cause of the inflated price: the corporate action leaves the investment with no Börsenplatz**, so ExtraETF
pulls no current quote — the price-freshness dot next to the price is **red** with a pre-split timestamp (hover
shows source + Stand). **Fix: open the investment → three-dots (⋮) → „Bearbeiten" and set a Börsenplatz** (e.g.
Stuttgart); the current post-split price is then used and the valuation corrects.
Quantity is a separate problem: modelling it manually **did not persist** (a Kauf on either ISIN closed the dialog
but created no transaction and left the Verrechnungskonto unchanged; TYP is **locked to "Kauf"**, so Einbuchung
isn't selectable), so (re)create the holding via **CSV import** of an `Einbuchung` row. ExtraETF also auto-reassigns
pre-split dividends to the surviving ISIN.
