# flightradar.fun

Live-Flugkarte mit Wettmärkten auf Cardano. Man klickt ein Flugzeug an und setzt darauf, wann es landet, ob es sich verspätet oder welches von mehreren Flugzeugen zuerst landet. An Flughäfen gibt es Märkte auf Ausfälle. Die Quoten ergeben sich aus den Pools der Wettenden. Gestartet wird jeder Markt mit einer Status-quo-Wahrscheinlichkeit aus einem Ankunftsmodell oder aus veröffentlichten Pünktlichkeits- und Ausfallquoten.

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

## Was es gibt

| Markt | Frage | Daten für die Entscheidung | Startquote aus |
|---|---|---|---|
| Landezeit | Landet LH400 vor 18:25 UTC in EDDF? | ADS-B: Aufsetzzeitpunkt am Ziel | ETA-Modell |
| Verspätung | Landet LH400 mehr als 15 Min. nach Plan? | ADS-B plus Planzeit vom Flugplan-Anbieter | Pünktlichkeitsstatistik oder ETA |
| Ausfall | Fällt LH400 am 2026-11-03 aus? | Status vom Flugplan-Anbieter, Start per ADS-B | Ausfallquote der Region |
| Rennen | Wer landet zuerst: LH400 oder BA902? | ADS-B: Aufsetzzeitpunkte | ETA-Modell, 2 bis 4 Flüge |

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

1. Operator-Wallet anlegen und am [Preprod-Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet) mit Test-ADA füllen. Für viele parallele Märkte die Mittel auf mehrere UTxOs verteilen.
2. `apps/server/.env.example` nach `.env` kopieren und `OPERATOR_SEED` eintragen; optional `BLOCKFROST_PROJECT_ID`, sonst Koios ohne Schlüssel.
3. Web-App bauen und vom Server ausliefern lassen:

```bash
npm run build -w @flightradar/web
cd apps/server && WEB_DIST=../web/dist node --env-file=.env --import tsx src/main.ts
```

Browser-Wallets wie Lace oder Eternl müssen auf Preprod stehen.

## Stand und offene Punkte

Getestet sind die Verträge, die Off-Chain-Logik und der komplette Ablauf auf dem Emulator mit echten Live-Flugdaten.

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
