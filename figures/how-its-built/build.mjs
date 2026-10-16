// "How a Fury gym is built": isometric figures that assemble each unit Fury offers, piece by
// piece, then take it apart and start again.
//
//   node figures/how-its-built/build.mjs
//     → public/how-its-built/<id>.html   one page per figure, for embedding (see below)
//     → public/how-its-built.html        the gallery, which loads those pages
//
// Each figure page takes URL options, so the same file serves a gallery card, a landing page
// hero or a loading screen:
//   theme=dark|light|tint   colours (default light)
//   frame=card|none         the framed card with title, readout and steps, or just the build
//   site=0                  hide the concrete pad and ruler and crop to the unit
//   interactive=0           no hover, click or keys (for loading screens)
//   paper=<css colour>      what the solids are filled with; match it to the page behind
//   speed=<number>          playback speed (1 is normal)
//   still=1                 show the finished unit only
//
// World units are inches (1 ft = 12): x along the unit's length, y across its width with the
// front at +y, z up. Nominal sizes come from src/lib/products.ts; part sizes follow the
// configurator's models (src/render/architecture.ts, addons.ts). Geometry is illustrative.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as k from '../kit/iso-kit.mjs'
import { containerFigure } from './container.mjs'
import { leafSvg, shutterSvg } from './moving.mjs'
import { studioFigure } from './studio.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', '..', 'public')
const DIR = join(OUT, 'how-its-built')

const FIGURES = [
  containerFigure({ fig: 'Fig 1' }),
  containerFigure({ opening: 'center', fig: 'Fig 2' }),
  containerFigure({ opening: 'partial', fig: 'Fig 3' }),
  containerFigure({ opening: 'full', fig: 'Fig 4' }),
  containerFigure({ length: 40, fig: 'Fig 5' }),
  studioFigure('single', 'Fig 6'),
  studioFigure('long', 'Fig 7'),
  studioFigure('double', 'Fig 8'),
  studioFigure('deck', 'Fig 9'),
  studioFigure('roof', 'Fig 10'),
  studioFigure('full', 'Fig 11'),
  studioFigure('stacked', 'Fig 12'),
]

// A third theme: light, with a quiet sage tint through the paper, faces and lines.
const TINT = `
.iso[data-theme="tint"]{
  --anatomy-page:#edf1ec;--anatomy-card:#f5f8f4;--anatomy-text:#4b5a52;--anatomy-strong:#16211c;--anatomy-muted:#84948b;
  --anatomy-paper:#f5f8f4;--anatomy-face:#fbfdfa;--anatomy-top:#fcfefb;
  --anatomy-shade-0:#d3ddd5;--anatomy-shade-1:#dde6df;--anatomy-shade-2:#e7eee8;--anatomy-shade-3:#f0f5f0;
  --anatomy-lit-top:#ffffff;--anatomy-lit-shade:#e8f0ea;
  --anatomy-hi:#1f2e27;--anatomy-mid:#6e8378;--anatomy-lo:#a7b8ae;--anatomy-faint:#cdd9d1;--anatomy-lit:#1d6b4f;
  --anatomy-halo:#5f7d6d;--anatomy-halo-opacity:.28;--anatomy-dot:#2f4038;
  --anatomy-lift:inset 0 1px 0 0 #ffffff,0 0 0 1px #1d3a2a12,0 1px 1px -.5px #1d3a2a0a,0 3px 3px -1.5px #1d3a2a0a,0 6px 6px -3px #1d3a2a0a;
}
body[data-theme="tint"]{color-scheme:light}
`

const FIGURE_CSS = `
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
`

const EMBED_CSS = `
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--anatomy-page);color:var(--anatomy-text);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;color-scheme:dark}
body[data-theme="light"]{color-scheme:light}
.cg-embed{padding:1px}
.cg-embed .iso-figure{margin:0}
body.cg-bare{background:transparent}
.cg-bare .cg-embed{padding:0}
.cg-bare .iso-plate{padding:0;background:none;box-shadow:none;--anatomy-paper:var(--cg-paper,var(--anatomy-page))}
.cg-bare .iso-plate-corners,.cg-bare .iso-legend{display:none}
.cg-nosite .cg-site{display:none}
.cg-static .cg-stage{cursor:default;pointer-events:none}
`

/** One figure: the SVG with each item in its stage's group, inside the card markup. */
function figureHtml(f) {
  const body = f.items.map(({ stage, svg, k: at }) =>
    stage < 0
      ? `<g class="cg-site">${svg}</g>`
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

/** What the page needs to run a figure: its camera, timeline and any parts redrawn live. */
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

// The page runtime: options from the URL, then the figure's build loop.
const runtime = `
${leafSvg.toString()}
${shutterSvg.toString()}
const K = { towardViewer, extrude, solidSvg, cylinder, slabOf, segment, lineSvg };
const Q = new URLSearchParams(location.search);
const THEMES = ["dark", "light", "tint"];
const OPT = {
  theme: THEMES.includes(Q.get("theme")) ? Q.get("theme") : "light",
  card: Q.get("frame") === "card",
  site: Q.get("site") !== "0",
  interactive: Q.get("interactive") !== "0",
  speed: Math.max(0.1, Math.min(4, parseFloat(Q.get("speed")) || 1)),
  still: Q.get("still") === "1",
  paper: Q.get("paper"),
};
document.body.dataset.theme = OPT.theme;
document.body.classList.toggle("cg-bare", !OPT.card);
document.body.classList.toggle("cg-nosite", !OPT.site);
document.body.classList.toggle("cg-static", !OPT.interactive);
if (OPT.paper && CSS.supports("color", OPT.paper)) document.body.style.setProperty("--cg-paper", OPT.paper);
// A host page can switch the theme without reloading, and learns the height it needs.
addEventListener("message", (event) => {
  if (event.data && event.data.cg === "theme" && THEMES.includes(event.data.theme)) document.body.dataset.theme = event.data.theme;
});
const tell = () => parent !== window && parent.postMessage({ cg: "height", id: FIG.id, height: document.documentElement.scrollHeight }, "*");
new ResizeObserver(tell).observe(document.body);

const still = matchMedia("(prefers-reduced-motion: reduce)");
const calm = () => still.matches || OPT.still;
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

  // Without the pad, crop to the finished unit, with room above for parts coming down.
  if (!OPT.site) {
    draw(BUILT);
    const b = svg.getBBox();
    const rise = screenRise(Math.max(...STAGES.map((s) => s.drop)), P) * 0.7;
    const side = b.width * 0.03;
    svg.setAttribute("viewBox", [b.x - side, b.y - rise, b.width + 2 * side, b.height + rise + side].map((v) => v.toFixed(1)).join(" "));
  }

  let t = 0, target = 0, clock = 0, last = 0, frame = 0, visible = false, touring = !calm(), idle = 0, said = -2;
  function describe(started) {
    if (started === said) return;
    said = started;
    stage.setAttribute("aria-valuenow", String(started + 1));
    stage.setAttribute("aria-valuetext", started < 0 ? "Empty site" : "Step " + (started + 1) + " of " + N + ": " + STAGES[started].name);
  }
  function tick(now) {
    const dt = (last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60) * OPT.speed;
    last = now;
    if (touring) {
      clock = (clock + dt) % CYCLE;
      t = clock;
    } else {
      t = calm() ? target : t + (target - t) * (1 - Math.exp(-dt / 0.18));
      if (Math.abs(target - t) < 0.002) t = target;
    }
    describe(draw(t));
    const settled = !touring && t === target;
    frame = visible && !settled ? requestAnimationFrame(tick) : 0;
  }
  const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
  const resume = (delay) => {
    clearTimeout(idle);
    if (calm()) return;
    idle = setTimeout(() => { touring = true; clock = Math.min(t, BUILT); run(); }, delay);
  };
  const steer = (next) => { touring = false; target = clamp(next, 0, BUILT); resume(3600); run(); };
  new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
  if (OPT.interactive) {
    stage.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      const r = svg.getBoundingClientRect();
      steer(clamp(((event.clientX - r.left) / r.width - 0.12) / 0.76) * BUILT);
    });
    stage.addEventListener("pointerleave", () => resume(1400));
    stage.addEventListener("click", () => { touring = !calm(); clock = 0; t = target = calm() ? BUILT : 0; run(); });
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
      if (calm()) t = to;
      steer(to);
    });
  } else {
    stage.removeAttribute("tabindex");
  }
  if (calm()) { touring = false; t = target = BUILT; }
  describe(draw(calm() ? BUILT : 0));
}
mount(FIG);
tell();
`

const KIT = readFileSync(join(HERE, '..', 'kit', 'iso-kit.mjs'), 'utf8').replace(/^export /gm, '')
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let bytes = 0
for (const f of FIGURES) {
  const script = KIT + `\nconst FIG = ${JSON.stringify(runtimeOf(f))};\n` + runtime
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(f.title.replace(' · build', ''))} · how it's built</title><style>${k.ISO_CSS}${TINT}${FIGURE_CSS}${EMBED_CSS}</style></head><body class="iso cg-bare" data-theme="light"><main class="cg-embed">${figureHtml(f)}</main><script type="module">${script.replace(/<\/(script)/gi, '<\\/$1')}</script></body></html>`
  writeFileSync(join(DIR, `${f.id}.html`), page)
  bytes += page.length
}

// --- The gallery: every figure as a card, a theme switch, and how to embed them ----------------
const GALLERY_CSS = `
*{box-sizing:border-box}
html{color-scheme:dark}
body[data-theme="light"],body[data-theme="tint"]{color-scheme:light}
body{margin:0;background:var(--anatomy-page);color:var(--anatomy-text);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;transition:background .3s ease}
.cg-page{width:min(760px,100% - 32px);margin:56px auto 96px}
.cg-head{display:flex;flex-wrap:wrap;align-items:end;justify-content:space-between;gap:16px;margin-bottom:24px}
.cg-head h1{margin:0 0 6px;font-size:20px;font-weight:600;color:var(--anatomy-strong);letter-spacing:-.01em}
.cg-head p{margin:0;max-width:56ch}
.cg-themes{display:inline-flex;gap:2px;padding:2px;box-shadow:0 0 0 1px var(--anatomy-mid);font-family:var(--anatomy-mono);font-size:11.5px}
.cg-themes button{all:unset;cursor:pointer;padding:5px 12px;color:var(--anatomy-muted);letter-spacing:.04em}
.cg-themes button[aria-pressed="true"]{background:var(--anatomy-strong);color:var(--anatomy-page)}
.cg-themes button:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:2px}
.cg-group{margin:40px 0 10px;font-family:var(--anatomy-mono);font-size:11.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--anatomy-muted)}
.cg-frame{display:block;width:100%;height:640px;border:0;margin:0 0 28px;background:transparent}
.cg-embed-doc{margin-top:48px;padding-top:24px;box-shadow:0 -1px 0 var(--anatomy-faint)}
.cg-embed-doc h2{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--anatomy-strong)}
.cg-embed-doc code,.cg-embed-doc pre{font-family:var(--anatomy-mono);font-size:12px}
.cg-embed-doc pre{margin:12px 0;padding:12px 14px;overflow-x:auto;background:var(--anatomy-card);box-shadow:0 0 0 1px var(--anatomy-faint);color:var(--anatomy-strong)}
.cg-embed-doc table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
.cg-embed-doc td{padding:6px 8px 6px 0;vertical-align:top;box-shadow:0 1px 0 var(--anatomy-faint)}
.cg-embed-doc td:first-child{white-space:nowrap;font-family:var(--anatomy-mono);font-size:12px;color:var(--anatomy-strong)}
`
const groups = [
  ['Container Gym', FIGURES.filter((f) => f.id.startsWith('container'))],
  ['S-Series Studio', FIGURES.filter((f) => f.id.startsWith('studio'))],
]
const frames = groups
  .map(
    ([name, list]) =>
      `<h2 class="cg-group">${name}</h2>` +
      list
        .map(
          (f) =>
            `<iframe class="cg-frame" data-id="${f.id}" title="${esc(f.title)}" loading="lazy" src="how-its-built/${f.id}.html?frame=card&amp;theme=dark"></iframe>`,
        )
        .join(''),
  )
  .join('')
const options = [
  ['theme=dark|light|tint', 'Dark, white, or white with a light sage tint. Light is the default.'],
  [
    'frame=card',
    'The framed card with title, live readout, legend and steps. Without it you get just the build.',
  ],
  ['site=0', 'Hide the concrete pad and ruler and crop tight to the unit.'],
  ['interactive=0', 'No hover scrubbing, clicks or keys: for loading screens and backgrounds.'],
  [
    'paper=%23ffffff',
    'The colour solids are filled with. Set it to the background behind the build.',
  ],
  ['speed=1.5', 'Playback speed, from 0.1 to 4.'],
  ['still=1', 'Show the finished unit only, with no motion.'],
]
const gallery = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>How a Fury gym is built</title><style>${k.ISO_CSS}${TINT}${GALLERY_CSS}</style></head><body class="iso" data-theme="dark"><main class="cg-page">
<header class="cg-head"><div><h1>How a Fury gym is built</h1><p>Every unit and option Fury offers, assembled piece by piece. Sizes follow Fury's published specs; part geometry is illustrative, not manufacturer CAD.</p></div>
<div class="cg-themes" role="group" aria-label="Theme"><button type="button" data-theme="dark" aria-pressed="true">Dark</button><button type="button" data-theme="light" aria-pressed="false">White</button><button type="button" data-theme="tint" aria-pressed="false">Tint</button></div></header>
${frames}
<section class="cg-embed-doc"><h2>Use a build on its own</h2><p>Every figure is its own page under <code>/how-its-built/</code>. Embed one in an iframe for a landing page or a loading screen. With no options it shows just the build on a transparent background.</p>
<pre>&lt;iframe src="/how-its-built/studio-single.html?theme=light&amp;site=0&amp;interactive=0"
        title="S-Series Studio being built" style="border:0;width:100%;aspect-ratio:16/10"&gt;&lt;/iframe&gt;</pre>
<table>${options.map(([o, d]) => `<tr><td>${esc(o)}</td><td>${d}</td></tr>`).join('')}</table>
<table>${FIGURES.map((f) => `<tr><td>${f.id}.html</td><td>${esc(f.title.replace(' · build', ''))}</td></tr>`).join('')}</table>
<p>A host page can change the theme live with <code>frame.contentWindow.postMessage({ cg: "theme", theme: "tint" }, "*")</code>, and each figure posts <code>{ cg: "height", height }</code> to its parent whenever its height changes.</p></section>
</main><script>
const frames = [...document.querySelectorAll(".cg-frame")];
const buttons = [...document.querySelectorAll(".cg-themes button")];
const apply = (theme) => {
  document.body.dataset.theme = theme;
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === theme)));
  // Loaded figures switch in place; the rest load in the new theme.
  for (const f of frames) {
    if (f.dataset.loaded) f.contentWindow.postMessage({ cg: "theme", theme }, "*");
    else f.src = f.src.replace(/theme=[a-z]+/, "theme=" + theme);
  }
  const url = new URL(location.href);
  url.searchParams.set("theme", theme);
  history.replaceState(null, "", url);
};
buttons.forEach((b) => b.addEventListener("click", () => apply(b.dataset.theme)));
frames.forEach((f) => f.addEventListener("load", () => (f.dataset.loaded = "1")));
addEventListener("message", (event) => {
  const frame = frames.find((f) => f.contentWindow === event.source);
  if (frame && event.data && event.data.cg === "height") frame.style.height = Math.ceil(event.data.height) + "px";
});
const start = new URLSearchParams(location.search).get("theme");
if (["light", "tint"].includes(start)) apply(start);
</script></body></html>`
writeFileSync(join(OUT, 'how-its-built.html'), gallery)
rmSync(join(OUT, 'how-its-built-light.html'), { force: true })
console.log(
  `wrote public/how-its-built.html and ${FIGURES.length} figures in public/how-its-built/ (${(bytes / 1048576).toFixed(1)} MB)`,
)
