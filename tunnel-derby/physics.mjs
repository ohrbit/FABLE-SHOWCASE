// physics.mjs — flight kinematics + tunnel collision for Tunnel Derby (swarm round 1)
//
// Interface contract (ES module, Node-importable):
//   decodeGenome(g) -> Spec { thrust, mass, steerGain, shield }
//   class Ship { reset(); step(tunnel); }   // integrates motion, detects wall hits
//   simulate(ship, tunnel, steps) -> { dist, crashed }
//
// Physics model (NaN-free, fully deterministic given a genome + tunnel):
//   - The ship travels along the tunnel arc-length `s` with speed `v`.
//     Forward acceleration = thrust / mass (Newton), capped at MAX_SPEED.
//   - A lateral offset `off` from the tunnel centerline is integrated with a
//     spring-damper toward the centerline (steerGain) plus a deterministic
//     turbulence term (so steering skill actually matters — no RNG needed).
//   - Each step we sample the tunnel at the ship's progress:
//       const { x, y, r } = tunnel.sample(s);
//     If |off| exceeds (r - SHIP_R) the ship is scraping the wall. It survives
//     only while penetration depth <= shield; beyond that it crashes.
//   - Reaching the end (s >= tunnel.length) is success: crashed = false.

import { pathToFileURL } from 'node:url';
import { argv } from 'node:process';

// ---- tunable constants ------------------------------------------------------
const SHIP_R = 7;        // ship collision half-width
const MAX_SPEED = 12;    // hard cap on forward speed (arc-length / step)
const DAMP = 0.90;       // lateral velocity damping per step (keeps the spring stable)
const CURVE_FORCE = 240; // how hard a bending tunnel shoves the ship sideways
const SAMPLE_DS = 12;    // look-ahead/behind distance for local curvature estimate

// ---- genome decoding -------------------------------------------------------
// Number of genes this module expects. GA must supply at least this many.
export const GENE_COUNT = 4;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;

// Map a genome (array of ~[0,1] floats) to physical ship parameters.
//   g[0] -> thrust      (forward force)
//   g[1] -> mass        (inertia; higher = slower accel, steadier)
//   g[2] -> steerGain   (lateral correction strength)
//   g[3] -> shield      (tolerable wall penetration depth before crash)
export function decodeGenome(g = []) {
  const g0 = clamp01(+g[0] ?? 0);
  const g1 = clamp01(+g[1] ?? 0);
  const g2 = clamp01(+g[2] ?? 0);
  const g3 = clamp01(+g[3] ?? 0);
  return {
    thrust: lerp(0.5, 6.0, g0),
    mass: lerp(0.5, 4.0, g1),
    steerGain: lerp(0.02, 0.45, g2),
    shield: lerp(0, 45, g3),
  };
}

// ---- Ship ------------------------------------------------------------------
export class Ship {
  // Accepts a genome array (decoded internally) or a pre-built Spec object.
  constructor(genomeOrSpec) {
    if (Array.isArray(genomeOrSpec)) {
      this.spec = decodeGenome(genomeOrSpec);
    } else if (genomeOrSpec && typeof genomeOrSpec === 'object') {
      this.spec = {
        thrust: genomeOrSpec.thrust ?? 1,
        mass: genomeOrSpec.mass ?? 1,
        steerGain: genomeOrSpec.steerGain ?? 0.1,
        shield: genomeOrSpec.shield ?? 0,
      };
    } else {
      this.spec = decodeGenome([]);
    }
    this.reset();
  }

  reset() {
    this.s = 0;          // arc-length progress
    this.v = 0.5;        // forward speed (kick-start so it moves immediately)
    this.off = 0;        // lateral offset from centerline
    this.voff = 0;       // lateral velocity
    this.alive = true;
    this.crashed = false;
    this.maxDist = 0;
  }

  // Advance one step. `tunnel` must expose sample(t) -> { x, y, r }.
  step(tunnel) {
    if (!this.alive) return;
    const sp = this.spec;
    const dt = 1;

    // Forward dynamics: a = F/m, capped speed.
    const accel = sp.thrust / sp.mass;
    this.v = Math.min(this.v + accel * dt, MAX_SPEED);
    if (!(this.v >= 0)) this.v = 0; // NaN-guard
    this.s += this.v * dt;

    // Reached the end -> success.
    if (this.s >= tunnel.length) {
      this.alive = false;
      this.crashed = false;
      if (this.s > this.maxDist) this.maxDist = this.s;
      return;
    }

    // Lateral dynamics: a bending tunnel shoves the ship sideways via the
    // local centerline curvature. Estimating curvature from two nearby
    // samples gives the cross product of the tangent segments. A skilled
    // pilot (high steerGain) corrects against this; a weak one drifts into
    // the wall. This makes steering skill genuinely survival-relevant.
    const a = tunnel.sample(Math.max(0, this.s - SAMPLE_DS));
    const b = tunnel.sample(this.s);
    const c = tunnel.sample(Math.min(tunnel.length, this.s + SAMPLE_DS));
    let curve = 0;
    const ax = b.x - a.x, ay = b.y - a.y;
    const bx = c.x - b.x, by = c.y - b.y;
    const cross = ax * by - ay * bx;        // signed turn magnitude
    const len2 = (ax * ax + ay * ay) * (bx * bx + by * by);
    if (len2 > 1e-9) curve = cross / Math.sqrt(len2); // ~ sin(angle) of the bend
    // Centripetal demand: following a bend of curvature `curve` at speed `v`
    // needs lateral accel ~ curve * v^2. Normalize by MAX_SPEED^2 so the
    // constant is speed-independent. This couples steering AND thrust/mass to
    // survival: fast ships must steer harder or they drift into the wall.
    const lat = (tunnel.curveForce ?? CURVE_FORCE) * curve * (this.v * this.v) / (MAX_SPEED * MAX_SPEED);

    this.voff += (lat - sp.steerGain * this.off) * dt;
    this.voff *= DAMP;
    if (!isFinite(this.voff)) this.voff = 0;
    this.off += this.voff * dt;
    if (!isFinite(this.off)) this.off = 0;

    // Wall collision via tunnel.sample(progress).
    const cc = tunnel.sample(this.s);
    const limit = (cc.r - SHIP_R);
    if (!isFinite(limit) || !isFinite(this.off)) {
      this.alive = false;
      this.crashed = true;
      return;
    }
    const pen = Math.abs(this.off) - limit;
    if (pen > 0) {
      if (pen > sp.shield) {
        this.alive = false;
        this.crashed = true; // wall breach beyond shield tolerance
      } else {
        // Survive: clamp to wall and bounce, losing speed to scraping friction.
        this.off = (this.off >= 0 ? 1 : -1) * limit;
        this.voff = -this.voff * 0.5;
        this.v *= 0.82;
      }
    }

    if (this.s > this.maxDist) this.maxDist = this.s;
  }
}

// ---- simulate --------------------------------------------------------------
// Run a ship through `steps` steps (or until it dies / finishes).
// Returns { dist: max arc-length reached, crashed: true only on wall crash }.
export function simulate(ship, tunnel, steps = 2000) {
  ship.reset();
  const n = Number.isFinite(steps) ? steps : 2000;
  for (let i = 0; i < n; i++) {
    ship.step(tunnel);
    if (!ship.alive) break;
  }
  return { dist: ship.maxDist, crashed: ship.crashed };
}

// ---- self-test (run directly: node physics.mjs) ----------------------------
if (import.meta.url === pathToFileURL(argv[1]).href) {
  // Prefer the real sibling tunnel.mjs when available; otherwise use an
  // inline realistic mock (bending centerline + choke points) so this module
  // is fully self-testable in isolation.
  let tunnel;
  try {
    const mod = await import('./tunnel.mjs');
    tunnel = mod.generateTunnel(mod.makeRng ? mod.makeRng(12345) : (() => Math.random()), 4000);
    console.log('(self-test using real tunnel.mjs)');
  } catch {
    // Inline realistic mock: a gently winding centerline with choke points so
    // that a pilot with poor steering/shield actually crashes (self-test
    // isolation when the real tunnel.mjs is unavailable).
    const L = 4000, ds = 25;
    const cl = [];
    for (let i = 0; i <= L; i += ds) {
      const y = 120 * Math.sin(i / 260) + 50 * Math.sin(i / 150 + 0.9);
      const r = 70 + 45 * Math.cos(i / 520) - 0.4 * 45 * Math.max(0, Math.sin(i / 120 + 0.5));
      cl.push({ x: i, y, r: Math.max(22, r) });
    }
    tunnel = {
      length: L,
      sample(t) {
        const f = Math.max(0, Math.min(L, t)) / ds;
        const i = Math.min(Math.floor(f), cl.length - 2);
        const frac = f - i;
        const a = cl[i], b = cl[i + 1];
        return { x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac, r: Math.max(20, a.r + (b.r - a.r) * frac) };
      },
    };
    console.log('(self-test using inline mock tunnel)');
  }

  // A well-tuned pilot should reach the end.
  const good = new Ship([0.65, 0.45, 0.85, 0.25]);
  const rGood = simulate(good, tunnel, 2000);
  console.log('good genome:', rGood, '(expect crashed=false, dist>=length*0.5)');

  // A reckless pilot (no steering, no shield) should crash early.
  const bad = new Ship([0.95, 0.1, 0.0, 0.0]);
  const rBad = simulate(bad, tunnel, 2000);
  console.log('bad genome:', rBad, '(expect crashed=true, dist<<length)');

  // Stress test for NaN-freeness across random genomes / 2000 steps.
  let nanFree = true, everCrashed = false, everFinished = false;
  for (let seed = 0; seed < 80; seed++) {
    const g = Array.from({ length: GENE_COUNT }, (_, i) => ((seed * 31 + i * 17) % 100) / 100);
    const s = new Ship(g);
    const r = simulate(s, tunnel, 2000);
    if (!isFinite(r.dist) || Number.isNaN(r.dist)) { nanFree = false; break; }
    if (r.crashed) everCrashed = true; else everFinished = true;
  }
  console.log('NaN-free over 80 genomes x 2000 steps:', nanFree);
  console.log('differentiated (some crash, some finish):', everCrashed && everFinished);
  console.log('GENE_COUNT:', GENE_COUNT);
}
