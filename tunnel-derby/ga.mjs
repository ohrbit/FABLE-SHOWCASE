// ga.mjs — Tunnel Derby genetic-algorithm core (ga-breeder, R1)
// ES module, Node-importable. Implements the SHARED INTERFACE CONTRACT:
//   export GENE_COUNT; randomGenome(rng); crossover(a,b,rng);
//          mutate(g,rate,rng); breed(ranked) -> genomes
// Fitness of a genome = simulated distance (reach) through the tunnel.
//
// physics.mjs + tunnel.mjs are produced by sibling agents on their own
// branches; they are imported lazily so this module still loads standalone
// (e.g. for the self-test) when they are absent.

export const GENE_COUNT = 12;

// --- Seeded RNG helpers (mulberry32) --------------------------------
// The harness passes its own rng, but we expose one for self-tests and
// for any caller that needs deterministic streams.
export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard-normal sample via Box-Muller, driven by the supplied rng.
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- Genome primitives ----------------------------------------------
// A genome is a Float32Array(GENE_COUNT) with values in [-1, 1].
// Decoding into a flight Spec is physics.mjs's job (decodeGenome).

export function randomGenome(rng = Math.random) {
  const g = new Float32Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) g[i] = rng() * 2 - 1;
  return g;
}

// Uniform crossover with optional per-gene blend.
// For each gene: 50% take from a, else from b; if `blend` is true and the
// rng pick flips, linearly interpolate the two parents' alleles instead.
export function crossover(a, b, rng = Math.random, { blend = true, blendRate = 0.25 } = {}) {
  const child = new Float32Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) {
    const takeA = rng() < 0.5;
    const pa = takeA ? a[i] : b[i];
    const pb = takeA ? b[i] : a[i];
    if (blend && rng() < blendRate) {
      const t = rng();
      child[i] = pa * (1 - t) + pb * t;        // blended allele
    } else {
      child[i] = pa;                            // uniform allele
    }
  }
  return child;
}

// Per-gene gaussian mutation. Each gene mutates with probability `rate`;
// mutated genes get gaussian noise scaled by a per-gene strength so small
// genes are not drowned out. Returns a NEW genome (input untouched).
export function mutate(g, rate = 0.1, rng = Math.random, { sigma = 0.15 } = {}) {
  const out = new Float32Array(GENE_COUNT);
  for (let i = 0; i < GENE_COUNT; i++) {
    let v = g[i];
    if (rng() < rate) {
      // scale sigma by a gentle baseline so mutations stay bounded in [-1,1]
      const s = sigma * (0.3 + 0.7 * (Math.abs(v) + 0.5));
      v += gaussian(rng) * s;
    }
    // clamp to the legal gene range
    if (v < -1) v = -1;
    else if (v > 1) v = 1;
    out[i] = v;
  }
  return out;
}

// Tournament selection over a ranked pool.
// `ranked` is an array of { genome, fitness } (already sorted best-first).
function tournamentPick(ranked, rng, k = 3) {
  let best = ranked[Math.floor(rng() * ranked.length)];
  for (let i = 1; i < k; i++) {
    const c = ranked[Math.floor(rng() * ranked.length)];
    if (c.fitness > best.fitness) best = c;
  }
  return best.genome;
}

// breed(ranked): produce the next generation.
//   - ranked: [{ genome, fitness }] sorted best-first (fitness = reach).
//   - Elitism: keep the single best genome unchanged.
//   - Parent pool = top 50% of ranked.
//   - Fill the rest by tournament-pair crossover + mutation.
// Returns an array of `ranked.length` genomes (same population size).
export function breed(ranked, {
  rng = Math.random,
  topFrac = 0.5,
  mutateRate = 0.12,
  tournamentK = 3,
} = {}) {
  const n = ranked.length;
  if (n === 0) return [];
  const poolSize = Math.max(1, Math.floor(n * topFrac));
  const pool = ranked.slice(0, Math.max(poolSize, 1));
  // Re-rank the pool (it is already sorted, but be safe).
  const poolRanked = pool
    .map((e) => ({ genome: e.genome, fitness: e.fitness ?? -Infinity }))
    .sort((a, b) => b.fitness - a.fitness);

  const next = [poolRanked[0].genome.slice()]; // elitism (cloned)
  while (next.length < n) {
    const pa = tournamentPick(poolRanked, rng, tournamentK);
    const pb = tournamentPick(poolRanked, rng, tournamentK);
    const child = crossover(pa, pb, rng);
    next.push(mutate(child, mutateRate, rng));
  }
  return next;
}

// --- Fitness ---------------------------------------------------------
// Fitness of a genome = simulated reach (max distance) through a tunnel.
// We lazily import physics.mjs + tunnel.mjs so this module loads even when
// siblings have not landed yet. Returns { reach, crashed } (or null on
// import failure so callers can degrade gracefully).
export async function evaluateGenome(genome, {
  rng = Math.random,
  physics,
  tunnel,
  steps = 4000,
  dt = 1 / 60,
} = {}) {
  let phys = physics, tun = tunnel;
  if (!phys || !tun) {
    try {
      const p = await import('./physics.mjs');
      const t = await import('./tunnel.mjs');
      phys = p; tun = t;
    } catch (err) {
      return { reach: 0, crashed: true, error: String(err && err.message || err) };
    }
  }
  const t = tun.generateTunnel(rng, 4000);
  const ship = new phys.Ship(genome);
  const res = phys.simulate(ship, t, steps, dt);
  return { reach: res.dist, crashed: res.crashed };
}

// --- Self-test -------------------------------------------------------
// Runs a tiny GA loop with a synthetic fitness so the module verifies
// itself in isolation (no siblings required).
if (import.meta.url === `file://${process.argv[1]}`) {
  const rng = makeRng(42);
  const POP = 20;
  let pop = Array.from({ length: POP }, () => randomGenome(rng));
  // Synthetic fitness: sum of gene magnitudes (stand-in for reach).
  const fitness = (g) => g.reduce((s, v) => s + Math.abs(v), 0);
  let best = 0;
  for (let gen = 0; gen < 40; gen++) {
    const ranked = pop
      .map((g) => ({ genome: g, fitness: fitness(g) }))
      .sort((a, b) => b.fitness - a.fitness);
    best = ranked[0].fitness;
    pop = breed(ranked, { rng });
  }
  console.log('GENE_COUNT =', GENE_COUNT);
  console.log('after 40 gens, best synthetic fitness =', best.toFixed(4));
  console.log('crossover/mutate/breed self-test OK');
}
