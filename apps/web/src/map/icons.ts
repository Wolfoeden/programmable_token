/** Map images drawn at runtime (no external sprites needed). */

/** Simple aircraft silhouette pointing north, as an alpha mask for SDF tinting. */
export function planeImage(size = 64): ImageData {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  const s = size / 64;
  g.scale(s, s);
  g.fillStyle = "#fff";
  g.beginPath();
  // fuselage
  g.moveTo(32, 4);
  g.bezierCurveTo(35.5, 6, 36, 11, 36, 16);
  g.lineTo(36, 24);
  // right wing
  g.lineTo(60, 36);
  g.lineTo(60, 40);
  g.lineTo(36, 34);
  g.lineTo(35, 50);
  // right tail
  g.lineTo(44, 56);
  g.lineTo(44, 59);
  g.lineTo(32, 56);
  // left tail
  g.lineTo(20, 59);
  g.lineTo(20, 56);
  g.lineTo(29, 50);
  g.lineTo(28, 34);
  // left wing
  g.lineTo(4, 40);
  g.lineTo(4, 36);
  g.lineTo(28, 24);
  g.lineTo(28, 16);
  g.bezierCurveTo(28, 11, 28.5, 6, 32, 4);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, size, size);
}

/** Ring drawn around aircraft that have open markets. */
export function ringImage(size = 64): ImageData {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.strokeStyle = "#fff";
  g.lineWidth = size * 0.07;
  g.beginPath();
  g.arc(size / 2, size / 2, size * 0.42, 0, Math.PI * 2);
  g.stroke();
  return g.getImageData(0, 0, size, size);
}
