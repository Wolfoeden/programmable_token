/**
 * Market questions. A question is stored on-chain in the market datum and
 * fully determines how the oracle settles the market.
 *
 * Outcome indices:
 * - landing_before: 0 = YES (touches down before threshold), 1 = NO
 * - delay:          0 = YES (touches down at or after scheduled + minutes), 1 = NO
 * - cancellation:   0 = YES (cancelled), 1 = NO (operates)
 * - race:           i = flight i touches down first
 *
 * Any market is voided (stakes refunded) if the flight lands somewhere else
 * than its destination, or if no landing is observed before the resolve
 * deadline. Voiding on diversion removes any reward for causing one.
 */

export interface FlightRef {
  /** Callsign as broadcast, e.g. "DLH400". */
  callsign: string;
  /** IATA flight number if known, e.g. "LH400", otherwise "". */
  flightNumber: string;
  /** ICAO 24-bit address in lowercase hex, "" if unknown before departure. */
  icao24: string;
  /** ICAO code of the departure airport. */
  origin: string;
  /** ICAO code of the destination airport. */
  destination: string;
}

export type Question =
  | { kind: "landing_before"; flight: FlightRef; threshold: number }
  | { kind: "delay"; flight: FlightRef; scheduledArrival: number; minutes: number }
  | { kind: "cancellation"; flight: FlightRef; scheduledDeparture: number }
  | { kind: "race"; flights: FlightRef[] };

export type QuestionKind = Question["kind"];

export type Lang = "de" | "en";

export function outcomeCount(q: Question): number {
  return q.kind === "race" ? q.flights.length : 2;
}

export function flightsOf(q: Question): FlightRef[] {
  return q.kind === "race" ? q.flights : [q.flight];
}

/** Display name of a flight: flight number if known, else callsign. */
export function flightName(f: FlightRef): string {
  return f.flightNumber || f.callsign || f.icao24.toUpperCase();
}

export function utcTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const T = {
  de: {
    yes: "Ja",
    no: "Nein",
    landingBefore: (f: string, dest: string, t: string) => `Landet ${f} vor ${t} in ${dest}?`,
    delay: (f: string, m: number) => `Landet ${f} mehr als ${m} Min. nach Plan?`,
    cancellation: (f: string, d: string) => `Fällt ${f} am ${d} aus?`,
    race: (names: string[]) => `Wer landet zuerst: ${names.join(" oder ")}?`,
    first: (f: string) => `${f} zuerst`,
  },
  en: {
    yes: "Yes",
    no: "No",
    landingBefore: (f: string, dest: string, t: string) => `Will ${f} land at ${dest} before ${t}?`,
    delay: (f: string, m: number) => `Will ${f} land more than ${m} min late?`,
    cancellation: (f: string, d: string) => `Will ${f} on ${d} be cancelled?`,
    race: (names: string[]) => `Who lands first: ${names.join(" or ")}?`,
    first: (f: string) => `${f} first`,
  },
} as const;

export function questionTitle(q: Question, lang: Lang = "de"): string {
  const t = T[lang];
  switch (q.kind) {
    case "landing_before":
      return t.landingBefore(flightName(q.flight), q.flight.destination, utcTime(q.threshold));
    case "delay":
      return t.delay(flightName(q.flight), q.minutes);
    case "cancellation":
      return t.cancellation(flightName(q.flight), utcDate(q.scheduledDeparture));
    case "race":
      return t.race(q.flights.map(flightName));
  }
}

export function outcomeLabels(q: Question, lang: Lang = "de"): string[] {
  const t = T[lang];
  if (q.kind === "race") return q.flights.map((f) => t.first(flightName(f)));
  return [t.yes, t.no];
}

/** Settlement rules shown next to every market. */
export function questionRules(q: Question, lang: Lang = "de"): string {
  const de = lang === "de";
  const voidRule = de
    ? "Landet der Flug nicht am Ziel (Umleitung) oder ist bis zur Auflösungsfrist keine Landung beobachtbar, wird der Markt annulliert und alle Einsätze werden erstattet."
    : "If the flight lands anywhere but its destination (diversion), or no landing is observed by the resolve deadline, the market is voided and all stakes are refunded.";
  const touchdown = de
    ? "Maßgeblich ist der Zeitpunkt der ersten ADS-B-Bodenposition am Zielflughafen (öffentliche Daten). Reißt das Signal im kurzen Endanflug ab, wird er aus der letzten Position geschätzt."
    : "The time of the first ADS-B ground position at the destination airport counts (public data). If the signal is lost on short final, it is estimated from the last position.";
  switch (q.kind) {
    case "landing_before":
      return de
        ? `JA gewinnt, wenn ${flightName(q.flight)} vor ${utcTime(q.threshold)} in ${q.flight.destination} aufsetzt, sonst NEIN. ${touchdown} ${voidRule}`
        : `YES wins if ${flightName(q.flight)} touches down at ${q.flight.destination} before ${utcTime(q.threshold)}, otherwise NO. ${touchdown} ${voidRule}`;
    case "delay": {
      const limit = utcTime(q.scheduledArrival + q.minutes * 60_000);
      return de
        ? `Planmäßige Ankunft ${utcTime(q.scheduledArrival)}. JA gewinnt, wenn ${flightName(q.flight)} um oder nach ${limit} in ${q.flight.destination} aufsetzt, sonst NEIN. ${touchdown} Fällt der Flug aus, wird annulliert. ${voidRule}`
        : `Scheduled arrival ${utcTime(q.scheduledArrival)}. YES wins if ${flightName(q.flight)} touches down at ${q.flight.destination} at or after ${limit}, otherwise NO. ${touchdown} A cancelled flight voids the market. ${voidRule}`;
    }
    case "cancellation":
      return de
        ? `JA gewinnt, wenn der Flugplan-Anbieter ${flightName(q.flight)} (${q.flight.origin}–${q.flight.destination}, planmäßiger Abflug ${utcTime(q.scheduledDeparture)}) als gestrichen meldet. NEIN gewinnt, sobald der Flug abhebt. Ist bis zur Frist keines davon bekannt, wird annulliert.`
        : `YES wins if the schedule provider reports ${flightName(q.flight)} (${q.flight.origin}–${q.flight.destination}, scheduled departure ${utcTime(q.scheduledDeparture)}) as cancelled. NO wins once the flight takes off. If neither is known by the deadline, the market is voided.`;
    case "race":
      return de
        ? `Es gewinnt der Flug, der zuerst an seinem Ziel aufsetzt. ${touchdown} Landet einer der Flüge nicht an seinem Ziel, wird annulliert. ${voidRule}`
        : `The flight that touches down at its destination first wins. ${touchdown} If any flight lands elsewhere, the market is voided. ${voidRule}`;
  }
}

/** Short label for wallets (CIP-68 token name), at most 64 characters. */
export function tokenLabel(q: Question, outcome: number): string {
  const label = outcomeLabels(q, "en")[outcome] ?? `#${outcome}`;
  let subject: string;
  switch (q.kind) {
    case "landing_before":
      subject = `${flightName(q.flight)} <${utcTime(q.threshold).replace(" UTC", "Z")}`;
      break;
    case "delay":
      subject = `${flightName(q.flight)} late>${q.minutes}m`;
      break;
    case "cancellation":
      subject = `${flightName(q.flight)} cancelled ${utcDate(q.scheduledDeparture)}`;
      break;
    case "race":
      subject = "race";
      break;
  }
  return `${subject} ${label}`.slice(0, 64);
}
