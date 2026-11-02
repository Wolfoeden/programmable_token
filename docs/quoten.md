# Quoten und Status quo

Wie die Wahrscheinlichkeiten entstehen, mit denen jeder Markt startet, und wie sich daraus die Auszahlung berechnet. Der Code dazu liegt in `packages/core/src/parimutuel.ts`, `baseRates.ts`, `eta.ts` und `proposals.ts`; die On-Chain-Rechnung in `onchain/lib/flightradar/payout.ak` ist bit-genau dieselbe.

## Pool-Modell (Parimutuel)

Jeder Ausgang `i` hat einen Pool `qᵢ` in Lovelace. Wer setzt, bekommt pro Lovelace einen Positions-Token dieses Ausgangs (CIP-68, Label 333, 6 Dezimalstellen).

| Größe | Formel |
|---|---|
| Gesamteinsatz | `Q = Σ qᵢ` |
| Wahrscheinlichkeit von `i` | `pᵢ = qᵢ / Q` |
| Gebühr, wenn `w` gewinnt | `F = (Q − q_w) · f`, mit `f = 3 %` |
| Auszahlung je Gewinner-Token | `(Q − F) / q_w = 1 + (Q − q_w)(1 − f) / q_w` |
| Quote für einen kleinen Einsatz auf `i` | `oᵢ = 1 + (1 − pᵢ)/pᵢ · (1 − f)` |

Die Gebühr kommt nur aus den Verliererpools. Wer gewinnt, bekommt also nie weniger als den eigenen Einsatz zurück. Alle Divisionen runden ab, deshalb kann die Summe aller Auszahlungen den Topf nie übersteigen. Das prüfen Property-Tests mit Zufallsmärkten in Aiken.

**Beispiel.** Pools 7 ₳ auf „Ja", 3 ₳ auf „Nein", Gebühr 3 %:

| | Ja | Nein |
|---|---|---|
| Wahrscheinlichkeit | 70 % | 30 % |
| Quote | 1,42 | 3,26 |

Setzt jemand 5 ₳ auf „Nein", stehen die Pools bei 7 zu 8. Gewinnt „Nein", zahlt jeder Nein-Token `1 + 7/8 · 0,97 = 1,849` Lovelace. Aus 5 ₳ werden 9,24 ₳. Die Wahrscheinlichkeit für „Nein" liegt danach bei 53 %. Genau diese Verschiebung ist gemeint, wenn die Quote auf die Wetten der anderen reagiert.

Die endgültige Quote steht erst bei Wettschluss fest. Geld auf der Gegenseite erhöht sie, Geld auf der eigenen Seite senkt sie. Die App zeigt deshalb die Auszahlung „wenn jetzt Schluss wäre".

## Startquote: der Status quo

Ein leerer Pool hat keine Quote. Deshalb setzt der Betreiber bei jedem Markt einen kleinen Betrag, verteilt nach dem Modell: `qᵢ = S · pᵢ` mit `S = 20 ₳` (bei Ausfall-Märkten 100 ₳). Die erste Quote, die man sieht, ist damit die faire Quote des Modells. Der Startbetrag ist ein ganz normaler Einsatz: Der Betreiber hält die Token und kann gewinnen oder verlieren. Liegt das Modell daneben, verdienen informierte Wettende an diesem Startbetrag.

Damit beide Seiten wettbar bleiben, werden Startwahrscheinlichkeiten auf 2 bis 98 % begrenzt, und jeder Ausgang bekommt mindestens 1 ₳. Der Vertrag erzwingt diese Mindesteinlage, damit nie ein Gewinnerpool leer ist.

### Landezeit über/unter (Flugzeug in der Luft)

Ankunftsschätzung aus Position, Geschwindigkeit und Ziel. Die Modellannahmen stehen in `eta.ts`:

- geflogene Strecke = Großkreis × 1,05 + 20 km für Anflugrouten,
- die letzten 150 km mit höchstens 280 kt,
- Unsicherheit `σ = 1,5 min + 6 %` der Restflugzeit, normalverteilt.

Die Linie ist die ETA, gerundet auf 5 Minuten. Die Wahrscheinlichkeit ist `P(Landung vor T) = Φ((T − ETA) / σ)`.

**Beispiel.** Restflugzeit 60 min, also `σ = 5,1 min`. ETA 18:27, Linie 18:25:

| | Ja: vor 18:25 | Nein |
|---|---|---|
| Startwahrscheinlichkeit | 34,7 % | 65,3 % |
| Quote | 2,82 | 1,52 |

Wettschluss ist 15 Minuten oder 30 % der Restflugzeit vor der ETA, je nachdem, was früher ist.

Gemessen wird der Zeitpunkt der ersten ADS-B-Position mit Bodenstatus am Zielflughafen. Im Endanflug fragt das Oracle das Flugzeug alle 2 Sekunden ab, sonst alle 10 Sekunden. Die barometrische Höhe taugt dafür nicht: Sie bezieht sich auf Standarddruck. An einem Hochdrucktag zeigte ein Anflug auf Gatwick im Test kurz vor dem Aufsetzen −375 Fuß.

### Verspätung

Vor dem Abflug gilt die veröffentlichte Pünktlichkeit. 2025 kamen in Europa 76,1 % der Linienflüge höchstens 15 Minuten nach Plan an. Daraus folgen 23,9 % Verspätungen über 15 Minuten (EUROCONTROL European Aviation Overview 2025). In den USA waren es 23,6 %, bei durchschnittlich 74 Minuten Verspätung der verspäteten Flüge (BTS-Daten).

Für größere Schwellen fällt die Wahrscheinlichkeit exponentiell ab, mit dem veröffentlichten Mittelwert: `P(> m) = p₁₅ · exp(−(m − 15) / 59)`.

Der Markt misst den Aufsetzzeitpunkt aus ADS-B-Daten, die Statistik aber die Ankunft am Gate. Angenommen werden 7 Minuten Rollzeit dazwischen. „Aufsetzen mehr als 15 Min. nach Plan" entspricht damit „am Gate mehr als 22 Min. zu spät".

| Schwelle (Aufsetzen) | P(verspätet), Europa | Quote Ja | Quote Nein |
|---|---|---|---|
| > 15 Min. | 21,2 % | 4,60 | 1,26 |
| > 30 Min. | 16,5 % | 5,92 | 1,19 |
| > 60 Min. | 9,9 % | 9,83 | 1,11 |

Quoten jeweils für einen kleinen Einsatz und mit 3 % Gebühr.

Ist der Flug schon in der Luft, rechnet das ETA-Modell: `P(verspätet) = 1 − Φ((Plan + m − ETA) / σ)`.

### Ausfall

2025 fielen in Europa rund 0,98 % der Flüge aus (Cirium-Daten via AirAdvisor), in den USA 1,53 % (BTS-Daten via AirAdvisor). Wegen der Untergrenze startet ein europäischer Ausfall-Markt bei 2 %. Die Ja-Seite ist damit anfangs etwas teurer als fair. Das hält den Markt wettbar, und der Fehler geht zulasten des Betreibers.

Wettschluss ist 2 Stunden vor dem planmäßigen Abflug. Meldet der Flugplan-Anbieter die Streichung schon vorher, entscheidet das Oracle sofort, und der Markt nimmt keine Wetten mehr an.

### Rennen

Gewinner ist, wer zuerst an seinem Ziel aufsetzt. Bei zwei Flügen gilt `P(A zuerst) = Φ((ETA_B − ETA_A) / √(σ_A² + σ_B²))`. Bei drei oder vier Flügen wird mit einer deterministischen Monte-Carlo-Simulation mit 20.000 Läufen gerechnet.

**Beispiel.** A landet um 18:20 ± 4 Min., B um 18:24 ± 5 Min.:

| | A zuerst | B zuerst |
|---|---|---|
| Startwahrscheinlichkeit | 73,4 % | 26,6 % |

## Warum es manche Märkte nicht gibt

**Abstürze.** Der IATA-Fünfjahresschnitt 2021 bis 2025 liegt bei einem tödlichen Unfall auf 5,6 Millionen Flüge, also `p ≈ 0,000018 %`. Eine faire Quote auf „kommt an" wäre 1,0000002. Wer 1.000 ₳ setzt, gewinnt 0,0002 ₳, weniger als Staking im selben Zeitraum bringt. Auf „stürzt ab" läge die faire Quote bei 5,6 Millionen zu 1. Positiv wäre dieser Erwartungswert nur für jemanden, der den Absturz herbeiführen kann. Solche Märkte belohnen Gewalt und sind deshalb ausgeschlossen.

**Umleitungen, Durchstarten, Notfälle.** Dasselbe Problem in klein: Eine Bombendrohung, ein Laser oder ein vorgetäuschter Notfall können sie auslösen, und die seltenen Ereignisse hätten hohe Quoten. Stattdessen werden Märkte bei einer Umleitung annulliert, und alle bekommen ihren Einsatz zurück. Damit lohnt es sich nicht, eine Umleitung zu verursachen.

**Upgrades, Überbuchung, Gepäck.** Airlines veröffentlichen das nicht pro Flug. Ohne verlässliche öffentliche Quelle kann kein Oracle den Markt entscheiden.

**Obergrenzen.** Jeder Markt hat ein im Vertrag erzwungenes Limit für den Gesamteinsatz: 50.000 ₳, bei Ausfall-Märkten 5.000 ₳. Das begrenzt, was jemand gewinnen könnte, wenn er den Ausgang beeinflusst.

## Quellen

- EUROCONTROL, European Aviation Overview 2025, 23. Januar 2026: https://www.eurocontrol.int/sites/default/files/2026-01/eurocontrol-european-aviation-overview-20260123-2025-review.pdf
- IATA Safety Report 2025, Pressemitteilung: https://www.iata.org/en/pressroom/2026-releases/2026-03-09-01/
- U.S. PIRG zu den BTS-Pünktlichkeitsdaten 2025: https://pirg.org/colorado/media-center/new-report-on-time-arrivals-in-2025-hit-worst-level-since-2014/
- AirAdvisor, Flugstörungen weltweit (BTS- und Cirium-Daten): https://airadvisor.com/en/statistics/flight-disruption-global und https://airadvisor.com/en/statistics/global-flight-cancellations

Die Zahlen von AirAdvisor und PIRG sind Sekundärquellen. Die 7 Minuten Rollzeit und die Parameter des ETA-Modells sind Annahmen. Sie sollten mit den Daten aufgelöster Märkte nachkalibriert werden, die das Oracle als Belege speichert.
