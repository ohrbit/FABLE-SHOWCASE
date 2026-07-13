// tunnel.mjs — procedural tunnel generator for Tunnel Derby (swarm round 1)
//
// Interface contract (ES module, Node-importable):
//   generateTunnel(rng, length=4000) -> Tunnel
//   Tunnel = {
//     segments: [{ x, y, r, walls:[{x1,y1,x2,y2}] }],
//     length,
//     sample(t) -> { x, y, r }   // center + radius at arc-length t
//   }
// All randomness is drawn from the supplied `rng` (a () => [0,1) function),
// so the produced tunnel is fully deterministic for a given seed.

// ---- small helpers ----------------------------------------------------------

// Seeded RNG (mulberry32) so the self-test is reproducible without external libs.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- main export ------------------------------------------------------------

export function generateTunnel(rng, length = 4000) {
  if (typeof rng !== 'function') {
    throw new TypeError('generateTunnel(rng, length): rng must be a function returning [0,1)');
  }
  const ds = 25;                       // arc-length spacing between cross-sections
  const n = Math.max(2, Math.round(length / ds));
  const usable = n * ds;               // exact length we actually generate

  const baseR = 120;                  // nominal tunnel half-width
  const minR = 28;                    // narrowest a choke may get
  const maxR = 210;                   // widest a bulge may get

  // Pre-roll a few sine phases/amps so the radius varies smoothly along the run.
  const phases = Array.from({ length: 4 }, () => rng() * Math.PI * 2);
  const amps = [0.55, 0.30, 0.18, 0.12];

  const pts = [];                     // {x, y, r, theta}
  let x = 0, y = 0, theta = 0;       // start heading +x
  for (let i = 0; i <= n; i++) {
    const s = i * ds;                 // arc-length at this cross-section

    // Smoothly winding centerline: small per-step heading drift, eased at ends.
    const endEase = clamp(Math.min(s, usable - s) / (ds * 12), 0, 1);
    const turn = (rng() * 2 - 1) * 0.06 * endEase; // radians per step
    theta += turn;

    // Radius: sum of sines (smooth) + occasional sharp choke points.
    let rad =
      baseR *
      (1 -
        amps[0] * Math.cos((s / usable) * Math.PI * 2 + phases[0]) -
        amps[1] * Math.cos((s / usable) * Math.PI * 4 + phases[1]) -
        amps[2] * Math.cos((s / usable) * Math.PI * 9 + phases[2]) -
        amps[3] * Math.cos((s / usable) * Math.PI * 17 + phases[3]));
    // Random-ish choke spikes: ~ every 600 units, one narrow pass.
    if (rng() < 0.04) rad = lerp(rad, minR + rng() * (baseR - minR) * 0.4, 0.85);
    rad = clamp(rad, minR, maxR);

    // Keep the entrance and exit generous and straight-ish so ships can start/stop.
    if (i < 6) { rad = lerp(rad, maxR * 0.9, 1 - i / 6); theta *= 0.5; }
    if (i > n - 6) { rad = lerp(rad, maxR, (i - (n - 6)) / 6); }

    pts.push({ x, y, r: rad, theta });
    x += Math.cos(theta) * ds;
    y += Math.sin(theta) * ds;
  }

  // Build segments with wall line-segments connecting consecutive cross-sections.
  const segments = pts.map((p, i) => {
    const nx = Math.cos(p.theta + Math.PI / 2);
    const ny = Math.sin(p.theta + Math.PI / 2);
    const walls = [];
    if (i > 0) {
      const q = pts[i - 1];
      const qnx = Math.cos(q.theta + Math.PI / 2);
      const qny = Math.sin(q.theta + Math.PI / 2);
      // Left wall (centerline + normal*r) and right wall (centerline - normal*r).
      walls.push({
        x1: q.x + qnx * q.r, y1: q.y + qny * q.r,
        x2: p.x + nx * p.r, y2: p.y + ny * p.r,
      });
      walls.push({
        x1: q.x - qnx * q.r, y1: q.y - qny * q.r,
        x2: p.x - nx * p.r, y2: p.y - ny * p.r,
      });
    }
    return { x: p.x, y: p.y, r: p.r, walls };
  });

  // sample(t): arc-length -> {x, y, r}, linearly interpolated along the polyline.
  function sample(t) {
    const tt = clamp(t, 0, usable);
    const f = tt / ds;
    const i = Math.min(Math.floor(f), n - 1);
    const frac = f - i;
    const a = pts[i], b = pts[i + 1];
    return { x: lerp(a.x, b.x, frac), y: lerp(a.y, b.y, frac), r: lerp(a.r, b.r, frac) };
  }

  return { segments, length: usable, sample };
}

// ---- self-test (run directly: node tunnel.mjs) -----------------------------

import { pathToFileURL } from 'node:url';
import { argv } from 'node:process';

if (import.meta.url === pathToFileURL(argv[1]).href) {
  const rng = makeRng(12345);
  const tunnel = generateTunnel(rng, 4000);
  console.log('segments:', tunnel.segments.length);
  console.log('length:', tunnel.length);
  const mid = tunnel.sample(tunnel.length / 2);
  console.log('sample(mid):', { x: +mid.x.toFixed(1), y: +mid.y.toFixed(1), r: +mid.r.toFixed(1) });
  console.log('sample(0):', tunnel.sample(0));
  console.log('sample(length):', tunnel.sample(tunnel.length));
  // determinism check
  const t2 = generateTunnel(makeRng(12345), 4000);
  const ok = JSON.stringify(tunnel.segments) === JSON.stringify(t2.segments);
  console.log('deterministic for same seed:', ok);
}
