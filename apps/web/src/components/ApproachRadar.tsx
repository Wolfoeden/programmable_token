import { distanceKm } from "@flightradar/core/geo";
import type { TrackPoint } from "../types";

export interface RadarItem {
  hex: string;
  label: string;
  color: string;
  lat: number;
  lon: number;
  trackDeg?: number;
  trail: TrackPoint[];
  /** Last known position only (not live). */
  stale?: boolean;
}

const RANGES = [10, 25, 50, 100, 200, 400];
const SIZE = 240;
const R = SIZE / 2 - 14;

/**
 * Small to-scale map around one airport, north up: range rings, the
 * recorded path and the current position of each aircraft.
 */
export function ApproachRadar({ airport, items }: { airport: { lat: number; lon: number; iata?: string; icao: string }; items: RadarItem[] }) {
  const far = Math.max(5, ...items.map((i) => distanceKm(i, airport)));
  const range = RANGES.find((r) => r >= far * 1.1) ?? RANGES[RANGES.length - 1]!;
  const kx = Math.cos((airport.lat * Math.PI) / 180) * 111.32;
  const ky = 110.57;
  const xy = (lon: number, lat: number): [number, number] => {
    const x = ((lon - airport.lon) * kx * R) / range;
    const y = ((lat - airport.lat) * ky * R) / range;
    const d = Math.hypot(x, y);
    const f = d > R ? R / d : 1; // clamp to the edge
    return [SIZE / 2 + x * f, SIZE / 2 - y * f];
  };
  return (
    <figure className="radar">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`Approach view around ${airport.iata || airport.icao}, ${range} km radius`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="radar-ring" />
        <circle cx={SIZE / 2} cy={SIZE / 2} r={R / 2} className="radar-ring" />
        <line x1={SIZE / 2} y1={SIZE / 2 - R} x2={SIZE / 2} y2={SIZE / 2 + R} className="radar-axis" />
        <line x1={SIZE / 2 - R} y1={SIZE / 2} x2={SIZE / 2 + R} y2={SIZE / 2} className="radar-axis" />
        <text x={SIZE / 2 + 3} y={14} className="radar-label">
          N
        </text>
        <text x={SIZE / 2 + 3} y={SIZE / 2 + R / 2 - 3} className="radar-label">
          {range / 2} km
        </text>
        <text x={SIZE / 2 + 3} y={SIZE / 2 + R - 3} className="radar-label">
          {range} km
        </text>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={5} className="radar-airport" />
        <text x={SIZE / 2 + 8} y={SIZE / 2 + 14} className="radar-label strong">
          {airport.iata || airport.icao}
        </text>
        {items.map((i) => {
          const pts = [...i.trail.map((p) => xy(p[0], p[1])), xy(i.lon, i.lat)];
          const [x, y] = pts[pts.length - 1]!;
          return (
            <g key={i.hex} opacity={i.stale ? 0.55 : 1}>
              {pts.length > 1 && <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={i.color} strokeWidth={2} strokeLinejoin="round" />}
              <g transform={`translate(${x},${y}) rotate(${i.trackDeg ?? 0})`}>
                <path d="M0,-8 L5,6 L0,3 L-5,6 Z" fill={i.color} stroke="#0b0d10" strokeWidth={1} />
              </g>
              <text x={x + 8} y={y - 6} className="radar-label" fill={i.color}>
                {i.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>North up, to scale. Rings at {range / 2} and {range} km. Path recorded since the flight was listed.</figcaption>
    </figure>
  );
}
