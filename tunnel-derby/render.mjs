// render.mjs — Tunnel Derby canvas renderer (renderer role, Round 1 swarm)
//
// SHARED INTERFACE CONTRACT (ES module, browser-only at runtime):
//   export function drawScene(ctx, ships, tunnel, hud)
//
// Coordinates are WORLD space (same space as tunnel.mjs segments and
// physics.mjs Ship positions). drawScene owns the world->screen camera
// (follows the furthest-progressed alive ship) and is stateless per frame.
//
// Sibling modules (not imported here — coordinated only via the contract):
//   tunnel.mjs  generateTunnel(rng,length=4000) -> { segments, length, sample }
//   physics.mjs decodeGenome(g)->Spec; class Ship {...}; simulate(ship,tunnel,steps)->{dist,crashed}
//   ga.mjs      GENE_COUNT; randomGenome; crossover; mutate; breed
//
// A Ship (or any object) is read defensively:
//   pos {x,y} | x,y          position
//   angle | heading | theta  facing (radians)
//   crashed | dead | alive    crashed flag
//   color | id                styling
//
// hud (optional) understood fields:
//   { generation, best, alive, total, survival, convergence, fps, status }
//   Missing fields are simply skipped.

// ---- world->screen helpers ------------------------------------------------

function segTangent(seg, i) {
  const a = seg[Math.max(0, i - 1)];
  const b = seg[Math.min(seg.length - 1, i + 1)];
  let tx = b.x - a.x, ty = b.y - a.y;
  const m = Math.hypot(tx, ty) || 1;
  tx /= m; ty /= m;
  return { tx, ty }; // normal = (-ty, tx)
}

function readShip(s, idx) {
  const x = s?.pos?.x ?? s?.x ?? 0;
  const y = s?.pos?.y ?? s?.y ?? 0;
  const angle = s?.angle ?? s?.heading ?? s?.theta ?? 0;
  const crashed = !!(s?.crashed ?? s?.dead ?? (s?.alive === false));
  const color = s?.color ?? `hsl(${(idx * 47) % 360} 80% 60%)`;
  const id = s?.id ?? idx;
  const r = s?.radius ?? 9;
  return { x, y, angle, crashed, color, id, r };
}

function leadTarget(ships, tunnel) {
  let best = null, bestD = -Infinity;
  for (const s of ships) {
    const rs = readShip(s, 0);
    const d = tunnel?.sample ? approxDist(tunnel, rs.x, rs.y) : rs.x;
    if (d > bestD && !rs.crashed) { bestD = d; best = rs; }
  }
  return best ?? (ships.length ? readShip(ships[0], 0) : null);
}

// crude progress estimate: project onto start->end vector
function approxDist(tunnel, x, y) {
  const a = tunnel.sample(0), b = tunnel.sample(tunnel.length);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return ((x - a.x) * dx + (y - a.y) * dy) / len;
}

// ---- main export -----------------------------------------------------------

export function drawScene(ctx, ships = [], tunnel = null, hud = null, opts = {}) {
  if (!ctx || !ctx.canvas) throw new TypeError('drawScene: ctx must be a CanvasRenderingContext2D');
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const zoom = opts.zoom ?? 0.9;

  // 1) Background — deep space gradient.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#05060f');
  bg.addColorStop(1, '#0b0f24');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 2) Camera — follow the lead ship (or tunnel start).
  const lead = leadTarget(ships, tunnel);
  const camX = lead ? lead.x : (tunnel ? tunnel.sample(0).x : 0);
  const camY = lead ? lead.y : (tunnel ? tunnel.sample(0).y : 0);
  const toScreen = (wx, wy) => [ (wx - camX) * zoom + W / 2, (wy - camY) * zoom + H / 2 ];

  if (tunnel) drawTunnel(ctx, tunnel, toScreen, zoom, lead);

  // 3) Ships as oriented triangle polygons.
  ships.forEach((s, i) => drawShip(ctx, readShip(s, i), toScreen, zoom));

  // 4) Finish marker.
  if (tunnel) drawFinish(ctx, tunnel, toScreen, zoom);

  // 5) HUD overlay.
  if (hud) drawHud(ctx, hud, W, H);
}

function drawTunnel(ctx, tunnel, toScreen, zoom, lead) {
  const segs = tunnel.segments;
  if (!segs || !segs.length) return;
  const left = [], right = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const { tx, ty } = segTangent(segs, i);
    const nx = -ty, ny = tx;
    const l = toScreen(s.x + nx * s.r, s.y + ny * s.r);
    const r = toScreen(s.x - nx * s.r, s.y - ny * s.r);
    left.push(l); right.push(r);
  }

  // Filled corridor (glow gradient toward centre).
  const grad = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
  grad.addColorStop(0, 'rgba(40,70,140,0.55)');
  grad.addColorStop(0.5, 'rgba(20,30,70,0.30)');
  grad.addColorStop(1, 'rgba(40,70,140,0.55)');
  ctx.beginPath();
  ctx.moveTo(left[0][0], left[0][1]);
  for (let i = 1; i < left.length; i++) ctx.lineTo(left[i][0], left[i][1]);
  for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Bright walls.
  const drawWall = (pts, color) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 2 * zoom);
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };
  drawWall(left, '#5ad1ff');
  drawWall(right, '#5ad1ff');
}

function drawShip(ctx, rs, toScreen, zoom) {
  const [cx, cy] = toScreen(rs.x, rs.y);
  const L = Math.max(6, rs.r * zoom * 1.6);
  const a = rs.angle;
  const nose = [cx + Math.cos(a) * L, cy + Math.sin(a) * L];
  const bl = [cx + Math.cos(a + 2.5) * L * 0.6, cy + Math.sin(a + 2.5) * L * 0.6];
  const br = [cx + Math.cos(a - 2.5) * L * 0.6, cy + Math.sin(a - 2.5) * L * 0.6];

  ctx.beginPath();
  ctx.moveTo(nose[0], nose[1]);
  ctx.lineTo(bl[0], bl[1]);
  ctx.lineTo(br[0], br[1]);
  ctx.closePath();
  ctx.fillStyle = rs.crashed ? 'rgba(255,80,80,0.45)' : rs.color;
  ctx.strokeStyle = rs.crashed ? '#ff5050' : '#ffffff';
  ctx.lineWidth = 1;
  if (!rs.crashed) { ctx.shadowColor = rs.color; ctx.shadowBlur = 10; }
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawFinish(ctx, tunnel, toScreen, zoom) {
  const e = tunnel.sample(tunnel.length);
  const [x, y] = toScreen(e.x, e.y);
  ctx.beginPath();
  ctx.arc(x, y, Math.max(4, 14 * zoom), 0, Math.PI * 2);
  ctx.strokeStyle = '#7CFFB0';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawHud(ctx, hud, W, H) {
  const lines = [];
  if (hud.generation != null) lines.push(`Gen ${hud.generation}`);
  if (hud.best != null) lines.push(`Best dist ${Math.round(hud.best)}`);
  if (hud.alive != null && hud.total != null) lines.push(`Alive ${hud.alive}/${hud.total}`);
  if (hud.survival != null) lines.push(`Survival ${Math.round(hud.survival * 100)}%`);
  if (hud.convergence != null) lines.push(`Gain/gen ${hud.convergence.toFixed(1)}`);
  if (hud.fps != null) lines.push(`${hud.fps.toFixed(0)} fps`);
  if (hud.status) lines.push(hud.status);

  if (!lines.length) return;
  ctx.font = '14px monospace';
  const pad = 10, lh = 18;
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const bh = lines.length * lh + pad * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(10, 10, bw, bh);
  ctx.fillStyle = '#cfe9ff';
  lines.forEach((l, i) => ctx.fillText(l, 10 + pad, 10 + pad + (i + 1) * lh - 4));
}

// ---- self-test (run directly: node render.mjs) -----------------------------
// Uses a recording stub context so the test runs in Node without a DOM.
import { pathToFileURL } from 'node:url';
import { argv } from 'node:process';

if (import.meta.url === pathToFileURL(argv[1]).href) {
  const calls = {};
  const stub = () => {};
  const ctx = {
    canvas: { width: 800, height: 600 },
    fillRect: stub, fill: stub, stroke: stub, beginPath: stub, closePath: stub,
    moveTo: stub, lineTo: stub, arc: stub,
    createLinearGradient: () => ({ addColorStop: stub }),
    measureText: () => ({ width: 40 }),
    fillText: stub,
    setLineDash: stub,
  };
  // count invocations of the key drawing primitives
  for (const k of ['fillRect', 'fill', 'stroke', 'moveTo', 'lineTo', 'arc']) {
    calls[k] = 0;
    ctx[k] = (...a) => { calls[k]++; };
  }
  // synthetic tunnel + ships
  const segs = [];
  for (let i = 0; i < 20; i++) segs.push({ x: i * 25, y: Math.sin(i / 3) * 30, r: 100 });
  const tunnel = {
    segments: segs, length: 500,
    sample: (t) => { const i = Math.min(segs.length - 1, Math.floor(t / 25)); return { x: segs[i].x, y: segs[i].y, r: segs[i].r }; },
  };
  const ships = [
    { pos: { x: 120, y: 5 }, angle: 0.2, color: 'hsl(200 80% 60%)', alive: true },
    { pos: { x: 80, y: -10 }, angle: -0.3, crashed: true },
  ];
  drawScene(ctx, ships, tunnel, { generation: 3, best: 300, alive: 1, total: 2, survival: 0.5, convergence: 12.3, fps: 60 });

  const ok = calls.fill > 0 && calls.stroke > 0 && calls.moveTo > 0 && calls.lineTo > 0;
  console.log('drawScene call counts:', calls);
  console.log('self-test passed:', ok);
  process.exit(ok ? 0 : 1);
}
