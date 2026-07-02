
# CapTrader → ExtraETF Konverter

Tool zur Konvertierung von CapTrader-Transaktionen (Cash, Trades) in ExtraETF-Import-CSVs.

![Der Konverter im Browser](docs/screenshot.png)

## Hinweise

> [!WARNING]
> **Kein offizielles Tool von ExtraETF, CapTrader oder Interactive Brokers.** Nutzung ohne Gewähr, auf eigenes Risiko.

> [!NOTE]
> **Datenschutz:** Läuft lokal im Browser – kein Server, keine Netzwerkaufrufe, keine Uploads.

## Warum dieses Tool?

ExtraETF bietet zwar einen Interactive-Brokers-Import über WealthAPI an (auch für CapTrader), doch die Einbindung ist fehleranfällig und die Daten unvollständig – z. B. werden ISINs abgeschnitten.

Verlässlicher ist der manuelle Export als *Flex-Query*-CSV, dessen Format aber nicht zum ExtraETF-Import passt. Dieses Tool rechnet die Exporte automatisch um (inklusive Anleihen, Fremdwährung, Quellensteuer, Stornos, Corporate Actions), sodass der importierte Depotwert dem CapTrader-Auszug entspricht.

## Was es kann

- **Trades** → `Kauf` / `Verkauf` (inkl. Gebühren, Fremdwährung, Wechselkurs)
- **Anleihen** → Kurs in % des Nominals, Nominalwert als Anzahl
- **Dividenden** → brutto mit zugeordneter Quellensteuer (netto = Preis − Steuern)
- **Stornobuchungen** (`BUY (Ca.)`) → über die vorzeichenbehaftete Stückzahl korrekt gegengebucht
- **Fremdwährungen** → Wechselkurs = Einheiten je EUR (= 1 / `FXRateToBase`)
- **Optionaler Bestandsabgleich:** mit CapTrader-*Bestand* ergänzt der Konverter `Einbuchung` / `Ausbuchung`, sodass die Positionen exakt dem Auszug entsprechen (z. B. bei Corporate Actions).

## Voraussetzungen

### Flex Queries in CapTrader einrichten

Im CapTrader-/IB-Kundenportal unter `Berichte → Flex Queries` zwei *Flex-Queries* anlegen:
  - **Trades:** Abschnitt 'Trades'
  - **Cash:** Abschnitt 'Bartransaktionen'

Beide Queries werden identisch konfiguriert – **bis auf die Wechselkurse**.

**Felder (Spalten)** – beim Anlegen der Query je Abschnitt mindestens diese Felder auswählen:

| Feld | Trade-Query | Cash-Query |
| --- | :---: | :---: |
| `CurrencyPrimary` | ✓ | ✓ |
| `FXRateToBase` | ✓ | ✓ |
| `AssetClass` | ✓ | |
| `Symbol` | ✓ | |
| `Description` | ✓ | ✓ |
| `ISIN` | ✓ | |
| `ListingExchange` | ✓ | |
| `TradeDate` | ✓ | |
| `Quantity` | ✓ | |
| `TradePrice` | ✓ | |
| `Taxes` | ✓ | |
| `IBCommission` | ✓ | |
| `Buy/Sell` | ✓ | |
| `Date/Time` | | ✓ |
| `Amount` | | ✓ |
| `Type` | | ✓ |

**Zustellungskonfiguration**

| Einstellung | Wert |
| --- | --- |
| Format | CSV |
| Überschrift und Trailer-Daten miteinbeziehen | Nein |
| Spaltenüberschriften miteinbeziehen | Ja |
| Einzelne Spalten-Titelzeile anzeigen | Nein |
| Abschnittscode und Zeilenbeschriftung miteinbeziehen | Nein |

**Allgemeine Konfiguration**

| Einstellung | Wert |
| --- | --- |
| Datumsformat | `dd/MM/yyyy` |
| Zeitformat | `HH:mm:ss` |
| Datum/Uhrzeit-Trennzeichen | `' '` (Leerzeichen) |
| Include Offsetting Trade/Cancel Pairs | Nein |
| **Wechselkurse miteinbeziehen** | Trades → Nein · Cash → Ja |
| Prüfpfadfelder einbeziehen | Nein |
| Aufschlüsselung nach Tagen | Nein |

Übrige Optionen (Modelle, Gewinn und Verlust, Konto-Pseudonym) bleiben auf Standard.

### Bestand exportieren (optional)

Der *Bestand* für den optionalen Bestandsabgleich wird im Kundenportal aus der Umsatzübersicht (`Berichte → Kontoauszüge → Kontoauszug`) als CSV exportiert.

## Schnellstart

1. Dieses Repository herunterladen und ggf. entpacken.
2. `captrader-to-extraetf.html` im Browser öffnen (Doppelklick genügt – kein Server nötig).
3. CapTrader-CSVs hineinziehen (Trades + Cash, optional den *Bestand*).
4. Vorschau und Hinweise prüfen.
5. „ExtraETF-Import-CSV herunterladen" → `extraetf-import.csv`.
6. In ExtraETF unter `Datenimport → CSV importieren` einlesen.

## Manuell nachzupflegen

ExtraETF importiert nur Wertpapier-Transaktionen. Cash-Bewegungen müssen manuell oder per Agenten nachgetragen werden. Der Konverter listet diese in der Kategorie „Cash / Kontobuchungen".

### Cash-Bewegungen

Erfasse sie auf ExtraETF über `Neue Aktivität → Cash` (und je Konto „Berücksichtigen" aktivieren, damit Cash zum Gesamtvermögen zählt):

| Cash-Bewegung | Erfassung |
| --- | --- |
| Ein-/Auszahlungen | Cash-Buchung |
| Broker-Zinsen | Cash-Buchung |
| Gebühren | Cash-Buchung |
| Quellensteuer auf Zinsen | Cash-Buchung |
| Anleihe-Stückzinsen | Cash-Buchung |
| Anleihe-Kupons | `Dividende` auf die Anleihe (kein `Kupon`-Typ; Betrag in „Dividendensumme (vor Steuern)", Position bleibt unverändert) |

### Verrechnungskonto

Kontostand auf den CapTrader-Endbarsaldo abgleichen (dokumentierte Zahlungsströme als Cash-Buchungen, verbleibende FX-/Rundungsdifferenz als eine Ausgleichsbuchung).

## Automatisierung (Agent & Skill)

> [!CAUTION]
> Der Agent bucht in deinem echten ExtraETF-Konto. Nutzung auf eigenes Risiko – Ergebnisse selbst prüfen.

Nachbuchungen lassen sich mit einem Claude-Code-Agenten und dem Skill [`extraetf-import-ops`](.claude/skills/extraetf-import-ops/) automatisieren: Das Skill kennt die UI-Abläufe der ExtraETF-Web-App, der Agent steuert die Oberfläche per Browser-Automation und bucht, was der CSV-Import nicht abdeckt.

1. Der Konverter listet unter „Cash / Kontobuchungen" alle nicht-importierbaren Buchungen samt Ziel-Endbarsaldo.
2. Du meldest dich selbst bei app.extraetf.com an – der Agent hält keine Zugangsdaten.
3. Der Agent bucht per `Neue Aktivität → Cash` Ein-/Auszahlungen, Zinsen, Gebühren und Steuern, die Kupons als `Dividende` auf die jeweilige Anleihe und gleicht zuletzt das Verrechnungskonto auf den CapTrader-Endbarsaldo ab.
4. Nach jeder Buchung liest er den Wert zurück und prüft das Verrechnungskonto, bevor er weitermacht.

Der Agent arbeitet nur am angegebenen Depot, fragt vor jeder Buchung nach (sofern nicht freigegeben) und steuert ausschließlich die Oberfläche – kein direkter API- oder Token-Zugriff.

## Bekannte ExtraETF-Besonderheiten

Der Konverter erzeugt eine korrekte CSV; die folgenden Punkte liegen an ExtraETF:

- **Typ:** erkennt ExtraETF selbst anhand der ISIN; die CSV-Spalte ist nur ein Hinweis.
- **Fremdwährungs-Dividenden:** ExtraETF ignoriert den Wechselkurs bei Dividenden und bucht Preis/Steuern als EUR (`318 HKD` → `318 €`); Käufe und Verkäufe werden korrekt umgerechnet. Workaround: solche Dividenden in EUR buchen (`Währung=EUR`).
- **Split mit ISIN-Wechsel:** ExtraETF fügt einen nicht löschbaren „Split" ein und bewertet die neue Stückzahl mit dem Vor-Split-Kurs (Position überhöht). Manuelle Käufe/Einbuchungen werden nicht gespeichert – Position nur per CSV-Import (`Einbuchung`) anlegen.

## Lizenz

Siehe [`LICENSE`](LICENSE).
