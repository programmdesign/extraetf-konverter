# CapTrader → ExtraETF Konverter

Ein einzelnes, abhängigkeitsfreies HTML-Tool, das **CapTrader / Interactive-Brokers Flex-Query-Exporte**
(Trades + Cash) in eine **ExtraETF-Import-CSV** umwandelt.

> 🔒 **Datenschutz:** Läuft vollständig lokal im Browser (HTML/JS, keine Abhängigkeiten, kein Server,
> keine Netzwerkaufrufe). Es werden keinerlei Daten hochgeladen.
>
> ⚠️ **Kein offizielles Tool:** Dieses Projekt – der Konverter **und** der Claude-Code-Skill
> (`.claude/skills/extraetf-import-ops/`) – steht in **keiner Verbindung** zu ExtraETF, CapTrader oder
> Interactive Brokers und wird von diesen weder bereitgestellt noch unterstützt oder geprüft. Nutzung
> **ohne Gewähr und auf eigenes Risiko** – die erzeugten Importe und Buchungen bitte selbst kontrollieren.

## Was es kann

- **Trades** → `Kauf` / `Verkauf` (inkl. Gebühren, Fremdwährung, Wechselkurs)
- **Anleihen** → Kurs in **% des Nominals**, Nominalwert als Anzahl
- **Dividenden** → **brutto** mit zugeordneter **Quellensteuer** (netto = Preis − Steuern)
- **Stornobuchungen** (`BUY (Ca.)`) → über die vorzeichenbehaftete Stückzahl korrekt gegengebucht
- **Fremdwährungen** (USD/HKD/GBP/NOK/SEK/…) → `Wechselkurs` = Einheiten je EUR (= 1 / IB `FXRateToBase`)
- **Optionaler Bestandsabgleich:** lädst du zusätzlich den CapTrader-*Bestand* (Aktivitätsauszug) hoch,
  ergänzt der Konverter automatisch `Einbuchung` / `Ausbuchung`, damit die Positionen exakt dem Auszug
  entsprechen (z. B. bei Corporate Actions).

## Schnellstart

1. `captrader-to-extraetf.html` im Browser öffnen (Doppelklick genügt – kein Server nötig).
2. Die CapTrader-CSVs hineinziehen (Trades + Cash, gern alle Jahre gleichzeitig; optional den *Bestand*).
3. Vorschau und Hinweise prüfen.
4. **„ExtraETF-Import-CSV herunterladen"** → `extraetf-import.csv`.
5. In ExtraETF unter **Datenimport → CSV importieren** einlesen (siehe unten).

## Flex Queries in CapTrader einrichten

Im CapTrader-/IB-Kundenportal unter **Berichte / Reporting → Flex Queries** zwei *Activity Flex Queries*
anlegen – eine für **Trades**, eine für **Cash**. Den Zeitraum auf die gewünschte Historie setzen
(benutzerdefinierter Bereich über die gesamte Kontolaufzeit **oder** pro Kalenderjahr – das Tool
verarbeitet beliebig viele Dateien auf einmal).

**Für beide Queries gleich:**

| Einstellung | Wert |
|---|---|
| Format | **CSV** |
| Spaltenüberschriften miteinbeziehen? | **Ja** |
| Überschrift/Trailer · Titelzeile · Abschnittscode · Prüfpfad · Tages-Aufschlüsselung | Nein |
| Datumsformat / Zeitformat / Trennzeichen | **dd/MM/yyyy** · HH:mm:ss · Leerzeichen |
| Include Offsetting Trade/Cancel Pairs? | Nein |

**Unterschiede:**

| | Trades-Query | Cash-Query |
|---|---|---|
| Abschnitt | `Trades` | `Bartransaktionen` (Cash Transactions) |
| Wechselkurse miteinbeziehen? | Nein | **Ja** |

- **Trades-Spalten:** `CurrencyPrimary, FXRateToBase, AssetClass, Symbol, Description, ISIN,
  ListingExchange, TradeDate, Exchange, Quantity, TradePrice, Taxes, IBCommission, IBCommissionCurrency, Buy/Sell`.
- **Cash-Datei** ist mehrteilig: zuerst *Bartransaktionen*
  (`…,Symbol,Description,Date/Time,SettleDate,Amount,Type`), danach eine Wechselkurstabelle
  (`Date/Time,FromCurrency,ToCurrency,Rate`). Der Konverter erkennt beide Abschnitte automatisch und
  nutzt nur die Bartransaktionen.

## Import in ExtraETF

1. Oben rechts **Datenimport → „CSV importieren"**, Ziel-**Depot** wählen.
2. `extraetf-import.csv` hochladen, Vorschau prüfen, **Speichern**.
   *(Der CSV-Import ist eine Premium-Funktion ab dem Tarif „Investor".)*

Format der erzeugten Datei (Semikolon-getrennt, deutsches Zahlenformat, `TT.MM.JJJJ`):

```
Datum;ISIN;Name;Typ;Transaktion;Preis;Anzahl;Gebühren;Steuern;Währung;Wechselkurs
```

## Manuell nachzupflegen (nicht per CSV importierbar)

ExtraETF importiert per CSV nur **Wertpapier-Transaktionen**. Reine Cash-Bewegungen listet der Konverter
unter **„Cash / Kontobuchungen"**; sie werden über **„Neue Aktivität → Cash"** erfasst (und je Konto
„Berücksichtigen" aktivieren, damit Cash zum Gesamtvermögen zählt):

- **Ein-/Auszahlungen, Broker-Zinsen, Gebühren, Quellensteuer auf Zinsen, Anleihe-Stückzinsen** → als Cash-Buchung.
- **Anleihe-Kupons:** ExtraETF hat **keinen `Kupon`-Typ** → am besten als **`Dividende` auf die jeweilige
  Anleihe** buchen (Betrag in „Dividendensumme (vor Steuern)"; die Position bleibt unverändert).
- **Verrechnungskonto:** Für ein exaktes Gesamtvermögen den Kontostand auf den CapTrader-Endbarsaldo
  abgleichen – dokumentierte Zahlungsströme als Cash-Buchungen, die verbleibende FX-/Rundungsdifferenz als
  eine Ausgleichsbuchung.

## Bekannte ExtraETF-Besonderheiten

Der Konverter erzeugt eine korrekte CSV; die folgenden Punkte liegen **an ExtraETF**:

- **Typ** wird von ExtraETF anhand der ISIN selbst erkannt – die Typ-Spalte der CSV ist nur ein Hinweis.
- **Fremdwährungs-Dividenden:** ExtraETF **ignoriert beim CSV-Import den `Wechselkurs` bei `Dividende`**
  und bucht `Preis` / `Steuern` als **EUR** (z. B. `318 HKD` → `318 €`, ~9× zu hoch; USD ≈ EUR fällt kaum
  auf). `Kauf` / `Verkauf` werden korrekt umgerechnet. Workaround: solche Dividenden in EUR umgerechnet
  buchen (Betrag in EUR, `Währung=EUR`) – oder bei ExtraETF melden.
- **Split mit ISIN-Wechsel** (z. B. 5:1 mit neuer ISIN): ExtraETF fügt einen **nicht löschbaren „Split"**
  ein und bewertet die neue Stückzahl mit dem **Vor-Split-Kurs** (Position überhöht). Manuelle
  `Kauf` / `Einbuchung` auf ein solches Papier **werden stillschweigend nicht gespeichert** – die Position
  lässt sich nur per **CSV-Import** (`Einbuchung`) anlegen.

## Projektstruktur

- `captrader-to-extraetf.html` — Oberfläche (öffnen & benutzen).
- `styles.css` — Styles. &nbsp; `converter.js` — Parsing-/Konvertierungslogik (gekapseltes Modul).
- `.claude/skills/extraetf-import-ops/` — Claude-Code-Skill für schnelle manuelle ExtraETF-Arbeiten
  (Buchen/Löschen, CSV-Import, Reconciliation, bekannte Import-Fehler).
- Eigene CapTrader-Exporte, `extraetf-import.csv` u. Ä. bleiben lokal und werden **nicht** versioniert
  (siehe `.gitignore`).

## Lizenz

Siehe [`LICENSE`](LICENSE).
