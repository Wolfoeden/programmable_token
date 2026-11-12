# flightradar.fun

Live-Flugkarte mit Wettmärkten auf Cardano. Man klickt ein Flugzeug an und setzt darauf, ob es vor einer bestimmten Uhrzeit landet. Die Quoten ergeben sich aus den Pools der Wettenden. Gestartet wird jeder Markt mit einer Status-quo-Wahrscheinlichkeit aus einem Ankunftsmodell oder aus veröffentlichten Pünktlichkeits- und Ausfallquoten.

Jeder Einsatz prägt einen programmierbaren Positions-Token nach CIP-68. Ein Aiken-Vertrag erzwingt die Pool-Buchhaltung: Einzahlung gleich geprägte Token, verbrannte Gewinner-Token gleich Auszahlung zum Pool-Kurs.

Wetten auf Abstürze, Umleitungen oder Notfälle gibt es bewusst nicht. Die Begründung samt Rechnung steht in [docs/quoten.md](docs/quoten.md).

## Schnellstart: Demo-Modus

Der Demo-Modus braucht weder Wallet noch Test-ADA. Die Blockchain läuft simuliert im Server (Lucid-Emulator mit den echten Plutus-Skripten), die Flugdaten sind live.

```bash
npm install
npm run demo                        # API auf :8787, simulierte Chain, Demo-Wallets Alice/Bob/Carol
npm run dev:web                     # Web-App auf :5173 (leitet /api an :8787 weiter)
```

Danach im Browser `http://localhost:5173` öffnen, „Wallet verbinden" klicken und eine Demo-Wallet wählen.

Hinter einem HTTPS-Proxy braucht Node 22 zusätzlich `NODE_USE_ENV_PROXY=1`.

## Welche Flüge die Karte zeigt

Die Website ist englischsprachig. Sie zeigt nur Flüge, die innerhalb der nächsten Stunde an einem von fünf Flughäfen mit Livestream landen: London Heathrow, Lanzarote, Las Vegas, Tokio Haneda und Madeira. Dazu kommen alle Flüge mit offenem Markt. Nur auf diese Flüge kann man wetten, und nur für diese Flughäfen gibt es den Stream-Link.

**Sichtbar ab Reiseflughöhe:** Ein Flug zu einem Live-Flughafen erscheint, sobald er in Reiseflughöhe ist (ab 20.000 ft, nicht mehr steigend) und auf das Ziel zufliegt, bis zu 5,5 Stunden vor der Landung. Weit entfernte Flüge findet der Server über ein Raster von rund 255 Abfragekreisen bis 3.800 km um die Flughäfen. Bereits gefundene Flüge verfolgt er danach gezielt per Transponder-Kennung, bis zu 40 pro Anfrage. Diese zweite Schleife läuft neben der nahen Abfrage, beide zusammen mit gut einer Anfrage pro Sekunde. **Wetten** kann man, sobald der Flug sichtbar ist. Wettschluss ist mindestens 20 Minuten vor der geschätzten Landung, bei weit entfernten Flügen früher, nämlich 30 % der Restflugzeit davor. Ist das Ziel noch nicht eindeutig (siehe unten), steht ein Hinweis im Panel. Fliegt die Maschine dann doch woandershin, annulliert das Oracle den Markt, und alle Einsätze gehen 1:1 zurück.

Als eindeutig gilt ein Flug, wenn er auf den Flughafen zufliegt, laut Routendaten dort landet und sein Abflughafen höchstens rund fünf Flugstunden entfernt ist, also bis 3.800 km. Eine ADS-B-Abfrage reicht 250 nm (463 km) weit, ein Jet ist eine Stunde vor der Landung aber 700–800 km entfernt. Deshalb fragt der Server pro Flughafen zusätzlich vier Punkte 380 km im Norden, Osten, Süden und Westen ab. So sieht er anfliegende Maschinen bis etwa 840 km weit. Die Abfragen wechseln sich ab: Der Flughafen selbst kommt etwa alle 15 s dran, jeder Ring-Punkt etwa einmal pro Minute. Die Last bleibt bei einer Anfrage alle 1,5 s. Routendaten sind oft falsch für den heutigen Tag: Airlines wie Southwest fliegen mit einer Flugnummer mehrere Teilstrecken, die Routendatenbank kennt nur eine. Ein Beispiel ist SWA2697, gelistet als Oakland → Las Vegas, tatsächlich unterwegs nach Phoenix. Ein Flug zählt deshalb nur, wenn alle drei Bedingungen gelten:
- Er liegt höchstens 40 km neben der Linie zwischen Abflug und Ziel.
- Er fliegt auf ±15° genau auf das Ziel zu.
- Seine Position passt zu keiner Strecke vom selben Abflughafen zu einem anderen großen Flughafen.

Solange zwei Ziele infrage kommen, erscheint der Flug nicht und bekommt keinen Markt. Landet ein Flug trotzdem woanders, wird der Markt annulliert, und alle Einsätze gehen 1:1 zurück. Die Abflughäfen erscheinen als blaue Rauten, mit einer gestrichelten Linie zum Flugzeug und einer grünen zum Live-Flughafen. Die Liste steht in `packages/core/src/webcams.ts`. Abflugtafeln und Ausfall-Märkte sind abgeschaltet.

### Landungen live verfolgen

- **Flug bleibt ausgewählt**: Verlässt der gewählte Flug die Liste, bleiben Panel, Stream und Karte bei ihm. Der Server verfolgt ihn weiter. Die Landung gilt als bestätigt, sobald die erste ADS-B-Bodenmeldung im Umkreis von 6 km um den Flughafen eintrifft. Kommt 5 Minuten lang weder Bodenmeldung noch Signal, zeigt die Seite „nicht bestätigt". Zum nächsten Flug wechselt die Seite nur auf Klick.
- **Live flights**: Ein Knopf oben öffnet die Liste aller beobachteten Flüge, die innerhalb der nächsten Stunde an einem Live-Flughafen landen. Sortiert nach geschätzter Ankunft, mit Strecke, Uhrzeit, Restminuten und „open"/„closed" für die Wette. Ein Klick wählt den Flug.

Die Daten dafür liefert `/api/aircraft` im Feld `arrivals`. Die Spuren bis zu vier Flügen stehen unter `/api/tracks?hex=…`.

### Angeboten wird nur „landet vor T"

- **Wettschluss**: spätestens 20 Minuten vor der geschätzten Landung (`CLOSE_LEAD_MIN` in `packages/core/src/eta.ts`). Kurz vor dem Aufsetzen kennt jeder, der die Anflugkette sieht, den Ausgang besser als unser Modell.
- **Schwelle**: Das Haus legt sie fest, nämlich die geschätzte Ankunft gerundet auf 5 Minuten. Nutzer können nur diesen Markt anlegen, keine eigenen Schwellen.
- **Abgeschaltet**: Rennen, weil Spieler genau die Paare wählen würden, bei denen das Modell falsch liegt. Verspätungs-Märkte mit simuliertem Flugplan, weil das eine erfundene Planzeit wäre. In `MarketMaker` lassen sie sich nur für Tests wieder einschalten.

### Annullieren

- **Automatisch**: Das Oracle annulliert einen Markt, sobald das Flugzeug erkennbar woanders hinfliegt: mehr als 80 km neben der Strecke, mit wachsendem Abstand, über mindestens 3 Minuten. Es wartet also nicht erst die Landung am falschen Ort ab.
- **Von Hand (Betreiber)**: `flightradar.fun/#operator` öffnen und den `ADMIN_TOKEN` aus Render eingeben. Danach hat jeder offene Markt den Knopf „Operator: void market". Der Grund erscheint bei den Spielern. Dahinter steht `POST /api/admin/markets/<id>/void` mit `Authorization: Bearer <ADMIN_TOKEN>`.
- **Auszahlung**: Der Vertrag erlaubt dem Betreiber jederzeit `Resolve` ohne Gewinner. Gebuchte Einsätze holt man unter „My bets" mit „Refund" 1:1 zurück. Noch nicht gebuchte Orders mit „Get … back".

## Schattenbetrieb

Bevor es feste Quoten gibt, sammelt der Server Daten, um Marge, Wettschluss und Limits zu bestimmen. Alles landet in `DATA_DIR/shadow` als JSON-Zeilen, eine Datei pro Tag:

- `flights-*.jsonl`: Für jeden gelisteten Flug etwa alle 30 Sekunden die Position und die Modellschätzung samt Unsicherheit. Dazu der Ausgang: Landezeit laut erster Bodenmeldung, Signal verloren oder aufgegeben.
- `bets-*.jsonl`: jede gebaute Wette mit Zeit, Markt, Seite, Einsatz, angezeigter Quote, Modellschätzung zu diesem Zeitpunkt und einem gesalzenen Hash der Wallet-Adresse. Dazu Zeilen `submitted` für tatsächlich eingereichte Wetten.

Mit `SHADOW_ALWAYS_ON=1` verfolgt der Server Flüge auch ohne Besucher. Mit `ADMIN_TOKEN` lassen sich die Dateien unter `/api/admin/shadow` herunterladen. Die Auswertung:

```bash
npm run shadow:report -w @flightradar/server -- data/shadow                        # lokal
npm run shadow:report -w @flightradar/server -- https://flightradar.fun <ADMIN_TOKEN> # vom Server
```

Der Bericht zeigt:
- **ETA-Fehler**: nach Vorlaufzeit, mit Verzerrung und Trefferquote im ±1σ- und ±2σ-Band.
- **Kalibrierung**: Modellwahrscheinlichkeit zum Wettschluss gegen die tatsächliche Häufigkeit, dazu die Marge, ab der keine Seite mehr Gewinn verspricht.
- **Besser informierter Spieler**: Er weiß 5, 10 oder 15 Minuten mehr als das Modell und wettet zum Schlusskurs. Gezeigt wird, was er bei welcher Marge verdient hätte.
- **Echte Spieler**: wann gewettet wurde und was das Haus mit diesen Wetten bei festen Modellquoten mit verschiedenen Margen verdient oder verloren hätte.

Schon die synthetischen Tests zeigen das Kernproblem: Ein Spieler mit 5 Minuten Wissensvorsprung bleibt auch bei 25 % Marge im Plus. Eine Marge dünnt nur seine Wetten aus. Gegen ihn helfen nur ein früher Wettschluss und Limits.

## Was es gibt

| Markt | Frage | Daten für die Entscheidung | Startquote aus |
|---|---|---|---|
| Landezeit | Landet LH400 vor 18:25 UTC in EDDF? | ADS-B: Aufsetzzeitpunkt am Ziel | ETA-Modell |

Verspätungs-, Ausfall- und Rennmärkte kann der Vertrag weiterhin abbilden, die Seite bietet sie aber nicht an.

Landet ein Flug woanders oder ist bis zur Frist keine Landung beobachtbar, wird annulliert, und alle Einsätze werden 1:1 erstattet. Das Oracle speichert zu jeder Entscheidung die Beobachtungen als Beleg (`DATA_DIR/evidence/<market>.json`), und die API liefert sie unter `/api/markets/<id>` aus.

## Aufbau

```
onchain/          Aiken-Verträge (Plutus V3) und Tests, plutus.json ist der gebaute Blueprint
packages/core     Reine Logik: Pool-Mathematik, Basisraten, ETA-Modell, Landeerkennung, Entscheidungsregeln
packages/chain    Cardano-Anbindung mit Lucid Evolution: Datum-Codecs, Transaktionen, Indexer
apps/server       API, ADS-B-Proxy, Market Maker, Oracle, Batcher, Demo-Modus
apps/web          React und MapLibre: Live-Karte, Flug-Panel, Wetten, Wallet (CIP-30)
docs/quoten.md    Quoten, Basisraten und Quellen
```

### Verträge

Ein einziges Skript `market` ist zugleich Minting-Policy und Spend-Validator. Policy-ID und Skript-Adresse sind deshalb derselbe Hash.

| Token | Asset-Name | Zweck |
|---|---|---|
| Markt-NFT | `MKT_` + Markt-ID | kennzeichnet die echte Markt-UTxO |
| Positions-Token | CIP-68 Label 333 + Markt-ID + Ausgang | 1 Token = 1 Lovelace Einsatz, 6 Dezimalstellen |
| Referenz-NFT | CIP-68 Label 100 + Markt-ID + Ausgang | trägt Name und Ticker für Wallets |

Zustandsübergänge der Markt-UTxO:

- **Bet**: Lovelace rein gleich geprägte Token; nur vor Wettschluss; kein Auszahlen oder Seitenwechsel vor Schluss; Obergrenze für den Gesamteinsatz.
- **Resolve**: nur das Oracle; nimmt höchstens die Gebühr vom Verliererpool.
- **ForceVoid**: jeder darf annullieren, wenn das Oracle die Frist verpasst.
- **Claim**: verbrannte Gewinner-Token gleich Auszahlung, bei Annullierung 1:1.
- **Close**: der Betreiber räumt frühestens 30 Tage nach der Auflösungsfrist ab, standardmäßig nach 90 Tagen.

**Jackpot (Side Bets):** Beim Wetten kann man optional 1 ₳ in einen Jackpot geben. Der Betrag reist im Order-Datum (`BetOrder.side`) mit. Der Order-Validator erzwingt, dass beim Einbuchen der Jackpot-Vertrag (`jackpot.ak`) um mindestens die Summe aller Side Bets der Transaktion wächst. Der Batcher kann sie also nicht behalten. Er legt sie als neue Ausgabe an der Jackpot-Adresse ab, und der Jackpot ist die Summe aller Ausgaben dort. Ausgeben, um hinzuzufügen, darf jeder, solange der Jackpot nicht schrumpft. Auszahlen darf vorerst nur der Betreiber: Die Gewinnregel, ein noch zu definierender Extremfall einer Wette, folgt. Der Stand steht im Menü und unter `/api/jackpot`.

Damit viele gleichzeitig wetten können, gibt es einen Order-Validator. Wer wettet, legt den Einsatz als Order ab, und ein Batcher bucht bis zu 20 Orders in einer Transaktion ein. Jede Auszahlung an den Order-Besitzer trägt als Datum die Output-Referenz der Order. So kann eine Zahlung nie zwei Orders bedienen. Orders lassen sich jederzeit stornieren, und nach Fristablauf kann sie jeder erstatten.

Geprüft wird das mit 86 Szenario-Tests in Aiken, darunter Angriffe: ohne Bezahlung prägen, zu viel entnehmen, fremde Orders stornieren, Doppelauszahlung, Müll-Token im Markt. Dazu kommen Property-Tests der Auszahlungsmathematik über Zufallsmärkte.

### Server

- **ADS-B**: adsb.lol im readsb-v2-Format mit getrennten Kontingenten für Karte und Oracle; bei HTTP 429 legt die Karte eine Pause ein und liefert den letzten Stand.
- **Routen**: adsbdb.com. Fliegt ein Flugzeug nicht Richtung der gemeldeten Route, gibt es keinen Markt.
- **Flugplan**: AeroDataBox, falls `AERODATABOX_KEY` gesetzt ist, sonst im Demo-Modus eine deutlich markierte Simulation.
- **Market Maker**: legt Märkte auf Anfrage an, setzt den Startbetrag nach Modell und vermeidet Duplikate.
- **Oracle**: verfolgt alle Flüge mit offenen Märkten, erkennt Landungen über Bodenpositionen oder Signalverlust im kurzen Endanflug und signiert die Entscheidung.
- **Wallet-Transaktionen**: Der Server baut unsignierte Transaktionen für CIP-30-Wallets, die Wallet signiert, der Server reicht ein. Das Frontend bleibt dadurch ohne WASM.

## Tests

```bash
npm run test:onchain    # Aiken: 86 Szenarien plus Property-Tests
npm test                # Vitest: Kernlogik, Emulator-Lebenszyklus, Server-Pipeline
npm run typecheck
npm run build -w @flightradar/web
```

Die Emulator-Tests führen die echten kompilierten Skripte aus: Markt anlegen, direkt und über Orders wetten, bündeln, stornieren, erstatten, auflösen, auszahlen, schließen, ForceVoid. Dazu Angriffsversuche, die am Validator scheitern müssen.

## Testnetz-Betrieb (Preprod)

1. Operator-Wallet anlegen, auf dem eigenen Rechner mit `npm run keygen -w @flightradar/server -- Preprod`, und am [Preprod-Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet) mit Test-ADA füllen. Für viele parallele Märkte die Mittel auf mehrere UTxOs verteilen.
2. `apps/server/.env.example` nach `.env` kopieren und `OPERATOR_SEED` eintragen; optional `BLOCKFROST_PROJECT_ID`, sonst Koios ohne Schlüssel.
3. Web-App bauen und vom Server ausliefern lassen:

```bash
npm run build -w @flightradar/web
cd apps/server && WEB_DIST=../web/dist node --env-file=.env --import tsx src/main.ts
```

Browser-Wallets wie Lace oder Eternl müssen auf Preprod stehen.

## Stand und offene Punkte

Getestet sind die Verträge, die Off-Chain-Logik und der komplette Ablauf auf dem Emulator mit echten Live-Flugdaten. Im Live-Test entschied das Oracle einen Landezeit-Markt auf einen echten Anflug nach London-Gatwick 21 Sekunden nach der ersten Bodenmeldung. Danach lief die Auszahlung an den Gewinner über die Web-App.

- **Testnetz**: Noch nicht live auf Preprod ausprobiert. Ein Betrieb mit Koios oder Blockfrost ist vorbereitet.
- **AeroDataBox**: Die Anbindung ist mangels Schlüssel ungetestet.
- **CIP-30-Wallets**: Mit einer echten Browser-Wallet ist der Ablauf noch nicht durchgespielt. Signieren und Einreichen nutzen dieselben Endpunkte wie die getesteten Demo-Wallets.
- **Referenz-Skripte**: Die Skripte reisen noch in jeder Transaktion mit. Mit Referenz-Skripten (CIP-33) würden Gebühren sinken und mehr Orders pro Batch passen.
- **Oracle**: Der Betreiber entscheidet zentral, mit gespeicherten Belegen. Eine dezentrale Variante, etwa mit Orcfax oder Charli3, wäre der nächste Schritt.
- **ETA-Modell**: Die Parameter sind Annahmen. Mit den Belegen aufgelöster Märkte lassen sie sich kalibrieren.

## Recht

Wetten mit Geldwert sind Glücksspiel. In Deutschland ist dafür eine Erlaubnis nach dem Glücksspielstaatsvertrag nötig, und daran ändert die Blockchain nichts. Der Server verweigert deshalb Mainnet ohne `ALLOW_MAINNET=1`. Testnetz und Demo-Modus arbeiten mit Spielgeld.

„Flightradar" ist eine Marke der Flightradar24 AB. Diese App nutzt weder deren Daten noch deren Oberfläche. Vor einem öffentlichen Start unter flightradar.fun sollte das markenrechtlich geprüft werden.

## Datenquellen und Lizenzen

- Positionen: [adsb.lol](https://adsb.lol), Daten unter ODbL, Namensnennung erforderlich
- Routen: [adsbdb.com](https://www.adsbdb.com)
- Flughäfen: [OurAirports](https://ourairports.com/data/), gemeinfrei
- Karte: [OpenFreeMap](https://openfreemap.org), © OpenMapTiles, © OpenStreetMap-Mitwirkende
- Flugpläne, optional: [AeroDataBox](https://aerodatabox.com)


## Safe Passage (feste Quoten)

Die Flugzeugansicht unterstützt separat gedeckte Safe-Passage-Märkte mit
JA **1,0001x** und NEIN **1000x**. NEIN gilt nur für verifizierten Absturz oder
Abschuss innerhalb einer roten Zone; Landung, Umkehr und Signalverlust allein
lösen kein NEIN aus. Bei Verdacht wird eingefroren, vor Verifikation gibt es
keine Auszahlung. Bestehende Landungswetten und deren Verträge bleiben erhalten.

Aktivierung, ausdrückliche Betreiberfinanzierung, Render-Free-Wiederherstellung,
Belegprüfung, feste Einsatzlimits und Abholung sind in
[docs/safe-passage.md](docs/safe-passage.md) beschrieben. Standardmäßig bleibt
SAFE_PASSAGE_ENABLED aus; ein Seitenaufruf finanziert keinen Markt.
`DATA_DIR=data` bleibt bestehen und dient als Cache. Bestätigte Sperren und neue
Verifikationsbelege werden von der Blockchain wiederhergestellt. Bei vollständigem
Cacheverlust brauchen offene Märkte eine ausdrückliche Betreiberprüfung.
