# CapTrader → ExtraETF Konverter

Ein einzelnes, abhängigkeitsfreies HTML-Tool, das **CapTrader / Interactive-Brokers Flex-Query-Exporte**
(Trades + Cash) in eine **ExtraETF-Import-CSV** umwandelt.

> 🔒 **Datenschutz:** Das Tool läuft vollständig lokal im Browser (reines HTML/JS, keine Abhängigkeiten,
> kein Server, keine Netzwerkaufrufe). Es werden keinerlei Daten hochgeladen.

## Was es kann

- **Trades** → `Kauf` / `Verkauf` (inkl. Gebühren, Fremdwährung, Wechselkurs)
- **Anleihen** → Kurs in **% des Nominals**, Nominalwert als Anzahl
- **Dividenden** → **brutto** mit zugeordneter **Quellensteuer** (netto = Preis − Steuern)
- **Stornobuchungen** (`BUY (Ca.)`) → über die vorzeichenbehaftete Stückzahl korrekt gegengebucht
- **Fremdwährungen** (USD/HKD/GBP/NOK/SEK/…) → `Wechselkurs` = Einheiten je EUR (= 1 / IB `FXRateToBase`)
- **Optionaler Bestandsabgleich:** lädst du zusätzlich den CapTrader-*Bestand* (Aktivitätsauszug) hoch,
  ergänzt der Konverter automatisch `Einbuchung`/`Ausbuchung`, damit die Positionen exakt dem Auszug
  entsprechen (z. B. für Corporate Actions).

## Schnellstart

1. `captrader-to-extraetf.html` im Browser öffnen (Doppelklick genügt – kein Server nötig).
2. Die CapTrader-CSV-Dateien hineinziehen (Trades + Cash, gern alle Jahre gleichzeitig; optional den *Bestand*).
3. Vorschau und Hinweise prüfen.
4. **„ExtraETF-Import-CSV herunterladen“** klicken → `extraetf-import.csv`.
5. In ExtraETF unter **Datenimport → CSV importieren** einlesen (siehe unten).

---

## Flex Queries in CapTrader einrichten

Im CapTrader-/IB-Kundenportal unter **Berichte / Reporting → Flex Queries** zwei *Activity Flex Queries* anlegen.
Wichtig ist bei beiden das **CSV-Format mit Spaltenüberschriften** und das **Datumsformat `dd/MM/yyyy`**.

> **Zeitraum:** Für einen vollständigen Import den Zeitraum auf die gewünschte Historie setzen – entweder
> einen benutzerdefinierten Bereich über die gesamte Kontolaufzeit oder pro Kalenderjahr exportieren
> (das Tool verarbeitet beliebig viele Dateien auf einmal). Die unten gezeigten Werte
> („Seit Jahresbeginn“ / „Letzter Geschäftstag“) sind die Standardwerte der Auslieferung.

### 1) Trades-Query — z. B. „ExtraETF“

**Abschnitte:** `Trades`

**Zustellungskonfiguration**

| Einstellung | Wert |
|---|---|
| Modelle | Alle |
| Format | **CSV** |
| Überschrift und Trailer-Daten miteinbeziehen? | Nein |
| Spaltenüberschriften miteinbeziehen? | **Ja** |
| Einzelne Spalten-Titelzeile anzeigen? | Nein |
| Abschnittscode und Zeilenbeschriftung miteinbeziehen? | Nein |
| Zeitraum | Seit Jahresbeginn · *(bzw. gewünschte Historie)* |

**Allgemeine Konfiguration**

| Einstellung | Wert |
|---|---|
| Datumsformat | **dd/MM/yyyy** |
| Zeitformat | HH:mm:ss |
| Datum/Uhrzeit-Trennzeichen | ' ' (Leerzeichen) |
| Gewinn und Verlust | Standard |
| Include Offsetting Trade/Cancel Pairs? | Nein |
| Wechselkurse miteinbeziehen? | Nein |
| Prüfpfadfelder einbeziehen? | Nein |
| Konto-Pseudonym anstelle der Konto-ID anzeigen? | Nein |
| Aufschlüsselung nach Tagen? | Nein |

Erwartete Spalten: `CurrencyPrimary, FXRateToBase, AssetClass, Symbol, Description, ISIN, ListingExchange,
TradeDate, Exchange, Quantity, TradePrice, Taxes, IBCommission, IBCommissionCurrency, Buy/Sell`.

### 2) Cash-Query — z. B. „ExtraETF (Cash)“

**Abschnitte:** `Bartransaktionen` (Cash Transactions)

**Zustellungskonfiguration**

| Einstellung | Wert |
|---|---|
| Modelle | Optional |
| Format | **CSV** |
| Überschrift und Trailer-Daten miteinbeziehen? | Nein |
| Spaltenüberschriften miteinbeziehen? | **Ja** |
| Einzelne Spalten-Titelzeile anzeigen? | Nein |
| Abschnittscode und Zeilenbeschriftung miteinbeziehen? | Nein |
| Zeitraum | Letzter Geschäftstag · *(bzw. gewünschte Historie)* |

**Allgemeine Konfiguration**

| Einstellung | Wert |
|---|---|
| Datumsformat | **dd/MM/yyyy** |
| Zeitformat | HH:mm:ss |
| Datum/Uhrzeit-Trennzeichen | ' ' (Leerzeichen) |
| Gewinn und Verlust | Standard |
| Include Offsetting Trade/Cancel Pairs? | Nein |
| Wechselkurse miteinbeziehen? | **Ja** |
| Prüfpfadfelder einbeziehen? | Nein |
| Konto-Pseudonym anstelle der Konto-ID anzeigen? | Nein |
| Aufschlüsselung nach Tagen? | Nein |

Die Cash-Datei ist mehrteilig: zuerst der Abschnitt *Bartransaktionen*
(`…,Symbol,Description,Date/Time,SettleDate,Amount,Type`), danach eine Tabelle mit Wechselkursen
(`Date/Time,FromCurrency,ToCurrency,Rate`). Der Konverter erkennt beide Abschnitte automatisch und nutzt
nur die Bartransaktionen.

---

## Import in ExtraETF

1. In ExtraETF oben rechts das **Datenimport**-Dropdown → **„CSV importieren“**.
2. Ziel-**Depot** auswählen.
3. `extraetf-import.csv` hochladen, Vorschau prüfen, **Speichern**.
   *(Der CSV-Import ist eine Premium-Funktion ab dem Tarif „Investor“.)*

Die erzeugte Datei folgt exakt dem ExtraETF-Schema (Semikolon-getrennt, deutsches Zahlenformat, `TT.MM.JJJJ`):

```
Datum;ISIN;Name;Typ;Transaktion;Preis;Anzahl;Gebühren;Steuern;Währung;Wechselkurs
```

---

## Manuell nachzupflegen (nicht per CSV importierbar)

ExtraETF importiert per CSV nur **Wertpapier-Transaktionen**. Reine Cash-Bewegungen listet der Konverter
im Abschnitt **„Cash / Kontobuchungen“** auf; sie werden bei Bedarf manuell über
**„Neue Aktivität → Cash“** erfasst (und je Konto „Berücksichtigen“ aktivieren, damit Cash zum
Gesamtvermögen zählt):

- **Ein-/Auszahlungen, Broker-Zinsen, Gebühren, Quellensteuer auf Zinsen, Anleihe-Stückzinsen** → als Cash-Buchung.
- **Anleihe-Kupons:** ExtraETF hat **keinen `Kupon`-Typ**. Kupons werden daher am besten als
  **`Dividende` auf die jeweilige Anleihe** gebucht (Betrag im Feld „Dividendensumme (vor Steuern)“; die
  Position bleibt unverändert). Der Konverter listet die Kuponsummen dafür auf.
- **Verrechnungskonto:** Für ein exaktes Gesamtvermögen den Kontostand auf den CapTrader-Endbarsaldo
  setzen (eine ausgleichende Cash-Buchung).

## Bekannte ExtraETF-Besonderheiten

- **Typ** wird von ExtraETF anhand der ISIN selbst erkannt – die vom Tool gesetzte Typ-Spalte ist nur ein Hinweis.
- **Split mit ISIN-Wechsel:** Wird eine alte (Vor-Split-)ISIN gehandelt, wendet ExtraETF den Split selbst an.
  Solche Einzelfälle ggf. direkt unter der Ziel-ISIN abbilden und den Positionsabgleich prüfen.

## Projektstruktur

- `captrader-to-extraetf.html` — das gesamte Tool (öffnen & benutzen).
- Eigene CapTrader-Exporte, `extraetf-import.csv` u. Ä. bleiben lokal und werden **nicht** versioniert (siehe `.gitignore`).
