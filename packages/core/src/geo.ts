/** Great-circle helpers on a spherical earth (good to ~0.5 % for our use). */

export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_NM = 1.852;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b` in degrees, 0..360. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Point reached from `from` after `distance` km on initial `bearing`. */
export function destinationPoint(from: LatLon, bearing: number, distance: number): LatLon {
  const δ = distance / EARTH_RADIUS_KM;
  const θ = toRad(bearing);
  const φ1 = toRad(from.lat);
  const λ1 = toRad(from.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** Smallest absolute difference between two headings in degrees. */
export function headingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Distance of `p` from the great circle through `a` and `b` (km, unsigned). */
export function crossTrackKm(p: LatLon, a: LatLon, b: LatLon): number {
  const d13 = distanceKm(a, p) / EARTH_RADIUS_KM;
  const t13 = (bearingDeg(a, p) * Math.PI) / 180;
  const t12 = (bearingDeg(a, b) * Math.PI) / 180;
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * EARTH_RADIUS_KM);
}
