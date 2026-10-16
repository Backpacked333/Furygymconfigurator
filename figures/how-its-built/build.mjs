// "How a Fury gym is built": isometric figures that assemble each product Fury offers, one card
// each, in five to seven seconds, then take it apart and start again.
//
//   node figures/how-its-built/build.mjs          → public/how-its-built.html
//   node figures/how-its-built/build.mjs --light  → public/how-its-built-light.html
//
// World units are inches (1 ft = 12): x along the unit's length, y across its width with the
// front at +y, z up. Nominal sizes come from src/lib/products.ts; part sizes follow the
// configurator's models (src/render/architecture.ts, addons.ts). Geometry is illustrative.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as k from '../kit/iso-kit.mjs'
import { containerFigure } from './container.mjs'
import { leafSvg, shutterSvg } from './moving.mjs'
import { studioFigure } from './studio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'public')
const theme = process.argv.includes('--light') ? 'light' : 'dark'

const FIGURES = [
  containerFigure(),
  studioFigure('single'),
  studioFigure('deck'),
  studioFigure('roof'),
  studioFigure('stacked'),
]

const css = `
.cg-hole{fill:var(--anatomy-shade-0);stroke:var(--anatomy-lo);stroke-width:var(--anatomy-weight);vector-effect:non-scaling-stroke}
.cg-glass{fill:var(--anatomy-hi);fill-opacity:.07;stroke:none}
.cg-svg [data-s] .iso-edge{transition:stroke .35s ease}
.cg-svg [data-s][data-on] .iso-edge{stroke:var(--anatomy-lit)}
.cg-stage{outline:none;touch-action:pan-y;cursor:ew-resize}
.cg-stage:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:6px}
.cg-steps{display:grid;grid-template-columns:repeat(auto-fill,minmax(176px,1fr));gap:2px 16px;margin:0;padding:0;list-style:none;font-family:var(--anatomy-mono);font-size:11.5px;color:var(--anatomy-muted)}
.cg-steps li{transition:color .3s ease}
.cg-steps li[data-on]{color:var(--anatomy-strong)}
.cg-steps li[data-done]{color:var(--anatomy-text)}
.cg-intro{margin:0 0 8px;color:var(--anatomy-text)}
.cg-intro h1{margin:0 0 6px;font-size:20px;font-weight:600;color:var(--anatomy-strong);letter-spacing:-.01em}
.cg-intro p{margin:0;max-width:62ch}
`

/** One card: the SVG with each item in its stage's group, the step list under it. */
function card(f) {
  const body = f.items.map(({ stage, svg, k: at }) =>
    stage < 0
      ? svg
      : `<g data-s="${stage}"${at == null ? '' : ` data-k="${at.toFixed(3)}"`}>${svg}</g>`,
  )
  const svg = k.figureSvg({
    width: f.width,
    height: f.height,
    className: 'cg-svg',
    label: f.label,
    body,
  })
  const count = f.stages.length
  const steps = `<ol class="cg-steps">${f.stages.map((s, i) => `<li>${String(i + 1).padStart(2, '0')} ${s.name}</li>`).join('')}</ol>`
  const plate = k.plateHtml({
    fig: f.fig,
    title: f.title,
    hint: 'Hover to scrub · click to replay',
    readout: 'site ready',
    keys: f.keys,
    caption: f.caption,
    body: `<div class="cg-stage" tabindex="0" role="slider" aria-label="${f.title}: build sequence. Arrow keys step through the ${count} stages, Home and End jump to the start and the finished build, Enter replays." aria-valuemin="0" aria-valuemax="${count}" aria-valuenow="0">${svg}</div>`,
  })
  return `<div data-fig="${f.id}">${plate.replace('</figcaption>', `${steps}</figcaption>`)}</div>`
}

/** What the page needs to run each figure: its camera, timeline and any parts redrawn live. */
function runtimeOf(f) {
  const timeline = f.stages.map((s, i) => ({ ...s, start: f.first + i * f.spacing, dur: f.dur }))
  const last = timeline[timeline.length - 1]
  const doors = f.doors ? timeline[f.doors.stage] : null
  const built = Math.max(last.start + last.dur, doors ? doors.start + doors.dur + f.doors.swing : 0)
  return {
    id: f.id,
    P: f.P,
    stages: timeline,
    built,
    done: f.done,
    doors: f.doors || null,
    shutter: f.shutter || null,
  }
}

const live = `
${leafSvg.toString()}
${shutterSvg.toString()}
const K = { towardViewer, extrude, solidSvg, cylinder, slabOf, segment, lineSvg };
const FIGS = ${JSON.stringify(FIGURES.map(runtimeOf))};
const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (t) => 1 - Math.pow(1 - t, 3);
const smooth = (t) => t * t * (3 - 2 * t);
const HOLD = 3, GAP = 0.5;

function mount(cfg) {
  const root = document.querySelector('[data-fig="' + cfg.id + '"]');
  const stage = root.querySelector(".cg-stage");
  const svg = stage.querySelector("svg");
  const readout = root.querySelector("[data-readout]");
  const steps = [...root.querySelectorAll(".cg-steps li")];
  const { P, stages: STAGES, built: BUILT, doors, shutter: SHUT } = cfg;
  const N = STAGES.length;
  const CLEAR = 0.6 + (N - 1) * 0.07;
  const CYCLE = BUILT + HOLD + CLEAR + GAP;
  // Pieces with a data-k land one after another within their step: k = 0 first, k = 1 last.
  const SPREAD = 0.62;
  const groups = STAGES.map((_, i) =>
    [...svg.querySelectorAll('[data-s="' + i + '"]')].map((el) => ({ el, k: el.dataset.k === undefined ? null : +el.dataset.k })),
  );
  const leaves = doors ? [-1, 1].map((side) => ({ side, el: svg.querySelector('[data-leaf="' + side + '"]'), angle: -1 })) : [];
  const shutter = SHUT ? { el: svg.querySelector("[data-shutter]"), bottom: SHUT.rest } : null;

  // Where every stage is at time t of the loop: its progress (0 → 1), the door angle and the shutter.
  function poseAt(t) {
    const out = STAGES.map(() => 0);
    let angle = 0, bottom = SHUT ? SHUT.rest : 0;
    if (t < BUILT + HOLD) {
      STAGES.forEach((s, i) => (out[i] = clamp((t - s.start) / s.dur)));
      if (doors) {
        const d = STAGES[doors.stage];
        angle = doors.open * (1 - smooth(clamp((t - d.start - d.dur) / doors.swing)));
      }
      if (SHUT) {
        const top = SHUT.sh.top;
        const roll = clamp((t - STAGES[SHUT.stage].start - SHUT.window.from) / (SHUT.window.to - SHUT.window.from));
        bottom = roll <= 0 ? top : roll < 0.5 ? top - (top - 40) * smooth(roll / 0.5) : 40 + (SHUT.rest - 40) * smooth((roll - 0.5) / 0.5);
      }
    } else {
      const u = t - BUILT - HOLD;
      STAGES.forEach((s, i) => (out[i] = 1 - clamp((u - (N - 1 - i) * 0.07) / 0.6)));
    }
    return { out, angle, bottom };
  }

  const shown = [], lit = [];
  function draw(t) {
    const { out, angle, bottom } = poseAt(t);
    out.forEach((p, i) => {
      if (shown[i] === p) return;
      shown[i] = p;
      for (const { el, k } of groups[i]) {
        const q = k === null ? p : clamp((p - k * SPREAD) / (1 - SPREAD));
        const lift = STAGES[i].drop * (1 - ease(q));
        el.setAttribute("transform", translateAlong(P, [0, 0, lift]));
        el.style.opacity = smooth(clamp(q / 0.4)).toFixed(3);
        el.style.visibility = q <= 0 ? "hidden" : "";
      }
    });
    const swinging = doors && angle > 0.001 && angle < doors.open - 0.001 && out[doors.stage] === 1;
    out.forEach((p, i) => {
      const on = (p > 0 && p < 1) || (doors && i === doors.stage && swinging);
      if (lit[i] === on) return;
      lit[i] = on;
      for (const { el } of groups[i]) el.toggleAttribute("data-on", on);
    });
    for (const leaf of leaves) {
      if (Math.abs(leaf.angle - angle) < 1e-4) continue;
      leaf.angle = angle;
      leaf.el.innerHTML = leafSvg(K, P, leaf.side, angle, { ...doors.leaf, pivot: [doors.pivotX, leaf.side * doors.pivotY] });
    }
    if (shutter && Math.abs(shutter.bottom - bottom) > 0.01) {
      shutter.bottom = bottom;
      shutter.el.innerHTML = shutterSvg(K, P, bottom, SHUT.sh);
    }
    // Readout and the step list come from the same pose.
    const started = out.reduce((last, p, i) => (p > 0 ? i : last), -1);
    const building = t < BUILT + HOLD;
    let text;
    if (!building) text = "clearing the pad";
    else if (t >= BUILT) text = cfg.done;
    else if (started < 0) text = "site ready";
    else text = String(started + 1).padStart(2, "0") + "/" + String(N).padStart(2, "0") + " · " + STAGES[started].name;
    if (readout.textContent !== text) readout.textContent = text;
    steps.forEach((li, i) => {
      const active = building && out[i] > 0 && (out[i] < 1 || (doors && i === doors.stage && swinging));
      li.toggleAttribute("data-on", active);
      li.toggleAttribute("data-done", building && out[i] >= 1 && !active);
    });
    return started;
  }

  let t = 0, target = 0, clock = 0, last = 0, frame = 0, visible = false, touring = !still.matches, idle = 0, said = -2;
  function describe(started) {
    if (started === said) return;
    said = started;
    stage.setAttribute("aria-valuenow", String(started + 1));
    stage.setAttribute("aria-valuetext", started < 0 ? "Empty site" : "Step " + (started + 1) + " of " + N + ": " + STAGES[started].name);
  }
  function tick(now) {
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
    last = now;
    if (touring) {
      clock = (clock + dt) % CYCLE;
      t = clock;
    } else {
      t = still.matches ? target : t + (target - t) * (1 - Math.exp(-dt / 0.18));
      if (Math.abs(target - t) < 0.002) t = target;
    }
    describe(draw(t));
    const settled = !touring && t === target;
    frame = visible && !settled ? requestAnimationFrame(tick) : 0;
  }
  const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
  const resume = (delay) => {
    clearTimeout(idle);
    if (still.matches) return;
    idle = setTimeout(() => { touring = true; clock = Math.min(t, BUILT); run(); }, delay);
  };
  const steer = (next) => { touring = false; target = clamp(next, 0, BUILT); resume(3600); run(); };
  new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
  stage.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const r = svg.getBoundingClientRect();
    steer(clamp(((event.clientX - r.left) / r.width - 0.12) / 0.76) * BUILT);
  });
  stage.addEventListener("pointerleave", () => resume(1400));
  stage.addEventListener("click", () => { touring = !still.matches; clock = 0; t = target = still.matches ? BUILT : 0; run(); });
  const ends = STAGES.map((s, i) => (i === N - 1 ? BUILT : s.start + s.dur));
  stage.addEventListener("keydown", (event) => {
    const now = touring ? Math.min(t, BUILT) : target;
    const at = ends.findIndex((e) => e > now + 0.01);
    const here = at < 0 ? N : at;
    let to = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") to = here >= N ? BUILT : ends[here];
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = here - 2 >= 0 ? ends[here - 2] : 0;
    if (event.key === "Home") to = 0;
    if (event.key === "End") to = BUILT;
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); stage.click(); return; }
    if (to === null) return;
    event.preventDefault();
    if (still.matches) t = to;
    steer(to);
  });
  if (still.matches) { touring = false; t = target = BUILT; }
  describe(draw(still.matches ? BUILT : 0));
}
FIGS.forEach(mount);
`

const intro = `<header class="cg-intro"><h1>How a Fury gym is built</h1><p>Every unit Fury offers, assembled step by step: the Container Gym, the S-Series Studio on its own, with a front deck and gazebo, with a rooftop deck and stairs, and stacked two levels high. Sizes follow Fury's published specs; part geometry is illustrative, not manufacturer CAD.</p></header>`
const page = k.pageHtml({
  title: 'How a Fury gym is built',
  theme,
  width: 760,
  body: intro + FIGURES.map(card).join('') + `<style>${css}</style>`,
  script:
    readFileSync(join(HERE, '..', 'kit', 'iso-kit.mjs'), 'utf8').replace(/^export /gm, '') + live,
})
const name = theme === 'light' ? 'how-its-built-light.html' : 'how-its-built.html'
writeFileSync(join(OUT, name), page)
console.log(
  'wrote',
  join('public', name),
  `${(page.length / 1024).toFixed(0)} KB`,
  FIGURES.map((f) => `${f.id}:${f.items.length}`).join(' '),
)
