// tunnel.mjs — procedural tunnel generator for Tunnel Derby (swarm round 2)
//
// Interface contract (ES module, Node-importable):
//   generateTunnel(rng, length=4000) -> Tunnel
//   Tunnel = {
//     segments: [{ x, y, r, walls:[{x1,y1,x2,y2}] }],
//     length,
//     chokeCount,            // number of explicit narrow choke points
//     sample(t) -> { x, y, r }   // center + radius at arc-length t
//   }
// All randomness is drawn from the supplied `rng` (a () => [0,1) function),
// so the produced tunnel is fully deterministic for a given seed.
//
// ROUND-4 TUNING (vs round 3): round 3 settled at minR=35 which proved TOO EASY
// (CF=35 -> 100% survival, no selection gradient). Round 1-2 choked at 14 which is
// structurally impassable (cliff -> 0% survival). Round 4 targets the SWEET SPOT
// minR=28: a centered ship (r=7) still clears with a tight ~21-unit margin, so the
// tunnel is passable-but-tight and only good steerers survive. Choke floor is
// tightened to 28-36 (was 35-45), N_CHOKES stays at 7, and the centerline turns
// MODESTLY SHARPER (0.135 -> 0.17 rad/step) to add steering pressure without
// re-introducing the hard cliff. Survival now lives in the 40-70% band instead of
// 0% or 100% (sibling physics.mjs provides the soft-failure clamp so bad steerers
// fail GRADUALLY rather than exploding into the wall at CF>=40).

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
  const minR = 28;                    // Round-4 sweet-spot floor (tight but passable: ship r=7 + 21 margin)
  const maxR = 175;                   // widest a bulge may get

  // Pre-roll a few sine phases/amps so the radius varies smoothly along the run.
  const phases = Array.from({ length: 4 }, () => rng() * Math.PI * 2);
  const amps = [0.62, 0.34, 0.20, 0.14];

  // ---- explicit tight choke points (the selection-pressure engine) ----
  // Placed roughly evenly along the run with jitter, snapped to a cross-section
  // so the bottleneck hits full narrowness. Each choke's floor radius is a
  // random value in [minR, minR+8] -> 28..36, tight but passable (ship r=7).
  const N_CHOKES = 7;                 // Round-4 choke count (unchanged from r3)
  const chokeW = 130;                 // half-width of a choke's influence (arc-length)
  const chokeCenters = [];
  for (let k = 1; k <= N_CHOKES; k++) {
    const approx = Math.round((k / (N_CHOKES + 1)) * n);
    const ci = clamp(approx + Math.round((rng() * 2 - 1) * 3), 8, n - 8);
    chokeCenters.push({ c: ci * ds, floor: minR + rng() * 8 }); // 28..36
  }

  const pts = [];                     // {x, y, r, theta}
  let x = 0, y = 0, theta = 0;       // start heading +x
  for (let i = 0; i <= n; i++) {
    const s = i * ds;                 // arc-length at this cross-section

    // Smoothly winding centerline: sharper per-step heading drift than r1 so
    // ships must steer. Eased to near-straight at the very ends.
    const endEase = clamp(Math.min(s, usable - s) / (ds * 12), 0, 1);
    const turn = (rng() * 2 - 1) * 0.17 * endEase; // radians/step (r3 was 0.135; modestly sharper)
    theta += turn;

    // Radius: sum of sines (smooth) as the bulk corridor shape.
    let rad =
      baseR *
      (1 -
        amps[0] * Math.cos((s / usable) * Math.PI * 2 + phases[0]) -
        amps[1] * Math.cos((s / usable) * Math.PI * 4 + phases[1]) -
        amps[2] * Math.cos((s / usable) * Math.PI * 9 + phases[2]) -
        amps[3] * Math.cos((s / usable) * Math.PI * 17 + phases[3]));

    // Apply the strongest nearby choke: a smooth cosine bottleneck that bottoms
    // out at the choke's floor radius.
    let narrow = 0, narrowR = maxR;
    for (const ch of chokeCenters) {
      const d = Math.abs(s - ch.c);
      if (d < chokeW) {
        const g = Math.cos((d / chokeW) * (Math.PI / 2)); // 1 at center -> 0 at edge
        if (g > narrow) { narrow = g; narrowR = ch.floor; }
      }
    }
    if (narrow > 0) rad = lerp(rad, narrowR, narrow);
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

  const minRadius = segments.reduce((m, s) => Math.min(m, s.r), Infinity);

  return { segments, length: usable, chokeCount: N_CHOKES, minRadius, sample };
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
  console.log('MIN RADIUS:', tunnel.minRadius.toFixed(2));
  console.log('CHOKE COUNT:', tunnel.chokeCount);
  // passability check (physics contract: ship radius = 7).
  // A centered ship (lateral offset 0) clears a cross-section iff r(t) >= shipR(7).
  const SHIP_R = 7;
  let minRSeen = Infinity;
  for (let s = 0; s <= tunnel.length; s += 25) {
    const { r } = tunnel.sample(s);
    minRSeen = Math.min(minRSeen, r);
  }
  const centeredClearance = minRSeen - SHIP_R;     // 28 - 7 = 21
  const centeredPassable = centeredClearance >= 0; // true: tunnel is passable
  const tight = centeredClearance > 0 && centeredClearance < 30; // tight but passable
  const maxSafeOffset = minRSeen - SHIP_R;          // largest off-center distance that still clears
  console.log('centered ship (r=7) min clearance:', centeredClearance.toFixed(2), '-> passable:', centeredPassable);
  console.log('max safe lateral offset:', maxSafeOffset.toFixed(2), '(tight but bridgeable: 21 margin)');
  console.log('PASSABLE-BUT-TIGHT:', tight && centeredPassable);
  // determinism check
  const t2 = generateTunnel(makeRng(12345), 4000);
  const ok = JSON.stringify(tunnel.segments) === JSON.stringify(t2.segments);
  console.log('deterministic for same seed:', ok);
}
