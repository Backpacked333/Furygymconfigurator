// "No excuses": the word EXCUSES stands on the pad in block letters, cracks and falls apart into a
// heap of blocks, and the blocks fly up one by one and become the parts of a full Studio with every
// add-on. The Studio is the same build as studioFigure('full'); this adds the letters over it and
// shifts its steps later, so the page runtime can play the blocks before and during the build.
import * as k from '../kit/iso-kit.mjs'
import { helpers } from './common.mjs'
import { studioFigure } from './studio.mjs'

// A 5 × 7 block face for each letter, top row first.
const GLYPHS = {
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
}
const WORD = 'EXCUSES'
const CELL = 8 // inches per block face
const GAP = 6 // between letters
const Y0 = 92 // the letters stand on the future deck, in front of the Studio
const DEEP = 14
const GROUND = -8 // top of the pad

/** A small deterministic random, so every build of the page is the same. */
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function excusesFigure(fig) {
  const base = studioFigure('full', fig)
  const P = base.P
  const { S, box } = helpers(P)
  const rand = seeded(7)

  // The blocks, letter by letter, then drawn far to near so nearer blocks cover farther ones.
  const width = WORD.length * 5 * CELL + (WORD.length - 1) * GAP
  const x0 = 16 - width / 2
  const cubes = []
  ;[...WORD].forEach((ch, n) => {
    const left = x0 + n * (5 * CELL + GAP)
    GLYPHS[ch].forEach((row, r) =>
      [...row].forEach((cell, c) => {
        if (cell !== '#') return
        const x = left + c * CELL
        const z = GROUND + (6 - r) * CELL
        // Where it lands when the word falls apart: near where it stood, scattered over the deck.
        const rx = Math.max(-146, Math.min(174, x + (rand() - 0.5) * 70))
        const ry = Y0 - 34 + rand() * 96
        cubes.push({
          x,
          z,
          col: (left - x0 + c * CELL) / width,
          row: r,
          rest: [rx, ry, GROUND],
          fall: rand() * 0.32 + (6 - r) * 0.012,
        })
      }),
    )
  })
  const depthOf = (c) => k.depthOf([c.x, Y0, c.z], P)
  cubes.sort((a, b) => depthOf(a) - depthOf(b))
  const centre = (p) => k.iso(p, P).map((v) => +v.toFixed(1))
  const overlay = `<g class="cg-cubes m-brick">${cubes
    .map(
      (c, i) =>
        `<g data-c="${i}">${S(box(c.x + 0.3, c.x + CELL - 0.3, Y0, Y0 + DEEP, c.z + 0.3, c.z + CELL - 0.3, 0.6), { tone: 'hi', crease: 'lo' })}</g>`,
    )
    .join('')}</g>`

  // The timeline: the word drops in, holds, shakes and falls apart, then the Studio's steps run
  // closer together than on their own page, so the whole piece stays near ten seconds.
  const T = { drop: 0.7, hold: 1.5, shake: 1.8, fall: 1.95, settle: 3.05, build: 3.35 }
  const spacing = 0.33
  const dur = 0.55
  const timeline = [
    { name: 'excuses fall apart', drop: 0, start: T.shake, dur: T.build - T.shake },
    ...base.stages.map((s, i) => ({ ...s, start: T.build + i * spacing, dur })),
  ]
  // The blocks fly into the Studio itself: plinth to glazing, before the deck and stairs begin.
  const studioSteps = base.stages.findIndex((s) => s.name.startsWith('deck'))
  return {
    ...base,
    id: 'no-excuses',
    fig,
    title: 'No excuses · build',
    items: base.items.map((it) => (it.stage < 0 ? it : { ...it, stage: it.stage + 1 })),
    stages: timeline,
    timeline,
    overlay,
    excuses: {
      T,
      targets: Array.from({ length: studioSteps }, (_, i) => i + 1),
      cubes: cubes.map((c) => ({
        at: centre([c.x + CELL / 2, Y0 + DEEP / 2, c.z + CELL / 2]),
        rest: centre([c.rest[0] + CELL / 2, c.rest[1] + DEEP / 2, c.rest[2] + CELL / 2]),
        col: +c.col.toFixed(3),
        fall: +c.fall.toFixed(3),
      })),
    },
    idle: 'excuses',
    clearing: 'no excuses',
    label: `The word EXCUSES in block letters falls apart into a heap of blocks, and the blocks fly up and become a Fury S-Series Studio with its front deck, gazebo, rooftop deck and stair: ${base.stages.map((s) => s.name).join(', ')}.`,
    caption:
      'No excuses: the word falls apart, and every block becomes part of a Fury S-Series Studio, built step by step with the front deck and gazebo, the rooftop deck with its glass balustrade, and the stair.',
    done: 'built · no excuses',
    keys: [
      { mark: 'lit', label: 'The pieces being set now' },
      { mark: 'raised', label: 'The blocks that were excuses' },
      { mark: 'flat', label: 'Floors, decks and glazing' },
    ],
  }
}
