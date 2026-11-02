/**
 * Status-quo probabilities ("base rates") used to seed markets before any
 * bettor has spoken. Every number carries its source. Where a value is a
 * modelling assumption rather than a published statistic, `assumption` says
 * so.
 */

export interface BaseRate {
  value: number;
  description: string;
  source: string;
  url?: string;
  assumption?: string;
}

export const BASE_RATES = {
  /** Share of scheduled flights arriving more than 15 min late, Europe 2025. */
  arrivalDelayOver15Europe: {
    value: 0.239,
    description: "Europe 2025: 76.1 % of network scheduled flights arrived within 15 minutes of schedule.",
    source: "EUROCONTROL European Aviation Overview 2025 (23 January 2026)",
    url: "https://www.eurocontrol.int/sites/default/files/2026-01/eurocontrol-european-aviation-overview-20260123-2025-review.pdf",
  },
  /** Share of US domestic flights arriving more than 15 min late, 2025. */
  arrivalDelayOver15US: {
    value: 0.236,
    description: "US domestic 2025: about 76.4 % on-time arrivals (BTS definition: within 15 minutes).",
    source: "US DOT BTS data as summarised by AirAdvisor and U.S. PIRG (2026)",
    url: "https://pirg.org/colorado/media-center/new-report-on-time-arrivals-in-2025-hit-worst-level-since-2014/",
  },
  /** Mean arrival delay of flights that were delayed (US 2025). */
  meanDelayOfDelayedMinutes: {
    value: 74,
    description: "US 2025: the average delayed flight arrived about 74 minutes late.",
    source: "US DOT BTS data as summarised by AirAdvisor (2026)",
    url: "https://airadvisor.com/en/statistics/flight-disruption-global",
  },
  cancellationEurope: {
    value: 0.0098,
    description: "Europe 2025: about 0.98 % of scheduled flights cancelled.",
    source: "Cirium data as summarised by AirAdvisor (2026)",
    url: "https://airadvisor.com/en/statistics/global-flight-cancellations",
  },
  cancellationUS: {
    value: 0.0153,
    description: "US 2025: 1.53 % of flights cancelled.",
    source: "US DOT BTS data as summarised by AirAdvisor (2026)",
    url: "https://airadvisor.com/en/statistics/flight-disruption-global",
  },
  /** Typical taxi-in time between touchdown and in-block. */
  taxiInMinutes: {
    value: 7,
    description: "Assumed time between touchdown and arrival at the gate.",
    source: "Modelling assumption",
    assumption: "Hub airports range from about 4 to 12 minutes; 7 is a middle value.",
  },
} as const satisfies Record<string, BaseRate>;

export type Region = "europe" | "us" | "other";

/** Rough region from an ICAO airport code prefix. */
export function regionOf(icao: string | undefined): Region {
  if (!icao) return "other";
  const c = icao[0]?.toUpperCase();
  if (c === "K" || icao.startsWith("PH") || icao.startsWith("PA")) return "us";
  if (c === "E" || c === "L" || icao.startsWith("BI") || icao.startsWith("UK") || icao.startsWith("LT")) return "europe";
  return "other";
}

export function cancellationRate(origin: string | undefined): number {
  switch (regionOf(origin)) {
    case "us":
      return BASE_RATES.cancellationUS.value;
    case "europe":
      return BASE_RATES.cancellationEurope.value;
    default:
      return (BASE_RATES.cancellationUS.value + BASE_RATES.cancellationEurope.value) / 2;
  }
}

/**
 * P(gate arrival delay > `minutes`) for a flight that has not departed yet.
 *
 * Model: the share above 15 minutes is the published punctuality figure.
 * Beyond that the delay is treated as exponential with the published mean of
 * delayed flights, so P(> m) = p15 * exp(-(m - 15) / (mean - 15)).
 * Valid for m >= 15.
 */
export function gateDelayExceedance(minutes: number, destination: string | undefined): number {
  const p15 =
    regionOf(destination) === "us"
      ? BASE_RATES.arrivalDelayOver15US.value
      : BASE_RATES.arrivalDelayOver15Europe.value;
  if (minutes <= 15) return p15;
  const meanExcess = BASE_RATES.meanDelayOfDelayedMinutes.value - 15;
  return p15 * Math.exp(-(minutes - 15) / meanExcess);
}

/**
 * P(touchdown later than scheduled arrival + `minutes`) before departure.
 * Touchdown happens about `taxiInMinutes` before the gate time that the
 * punctuality statistics measure.
 */
export function touchdownDelayExceedance(minutes: number, destination: string | undefined): number {
  return gateDelayExceedance(minutes + BASE_RATES.taxiInMinutes.value, destination);
}
