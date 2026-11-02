/** Points along the great circle from a to b, as [lon, lat] pairs. */
export function greatCircle(a: { lat: number; lon: number }, b: { lat: number; lon: number }, n = 48): [number, number][] {
  const r = Math.PI / 180;
  const [φ1, λ1, φ2, λ2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2));
  if (d === 0) return [[a.lon, a.lat]];
  const out: [number, number][] = [];
  let prevLon = a.lon;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    let lon = Math.atan2(y, x) / r;
    // keep the line continuous across the antimeridian
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    out.push([lon, Math.atan2(z, Math.hypot(x, y)) / r]);
  }
  return out;
}
