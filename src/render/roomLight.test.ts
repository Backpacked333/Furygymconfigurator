import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, productHeight, type Config } from '../lib/config'
import { FLOOR_Y, STUDIO, interiorBounds } from './envelope'
import { inReach, roomReach } from './roomLight'

const studio = DEFAULT_CONFIG
const container: Config = { ...DEFAULT_CONFIG, family: 'container', length: 20 }

describe("the room's lights in the live view", () => {
  for (const [name, c] of [
    ['Studio', studio],
    ['Container', container],
  ] as const) {
    const b = interiorBounds(c)
    const reach = roomReach(c)
    const at = (x: number, y: number, z: number) => inReach(reach, [x, y, z])

    it(`${name}: light everything in the room`, () => {
      expect(at(0, FLOOR_Y, 0)).toBe(true)
      expect(at(0, b.ceiling, b.back + 0.5)).toBe(true)
      expect(at(b.halfWidth, FLOOR_Y + 4, 0)).toBe(true)
      expect(at(-b.halfWidth, FLOOR_Y + 4, 0)).toBe(true)
      expect(at(0, FLOOR_Y + 4, b.back)).toBe(true)
      expect(at(0, FLOOR_Y + 1, b.front)).toBe(true)
    })

    it(`${name}: shine out through the glazing, onto the ground in front`, () => {
      expect(at(0, 0, b.front + 3)).toBe(true)
      expect(at(b.halfWidth - 1, -0.1, b.front + 12)).toBe(true)
    })

    it(`${name}: never light the shell from outside, or the ground beside and behind it`, () => {
      // The shell's outer faces: its sides at half the length, its roof, its back.
      expect(at(c.length / 2, FLOOR_Y + 4, 0)).toBe(false)
      expect(at(-c.length / 2, FLOOR_Y + 4, 0)).toBe(false)
      expect(at(0, productHeight(c) + (c.family === 'studio' ? STUDIO.base : 0), 0)).toBe(false)
      expect(at(0, FLOOR_Y + 4, b.back - 0.6)).toBe(false)
      // The paving beside, behind, and beside the glazing's view.
      expect(at(c.length / 2 + 3, 0, 0)).toBe(false)
      expect(at(0, 0, b.back - 3)).toBe(false)
      expect(at(c.length / 2 + 3, 0, b.front + 3)).toBe(false)
      // Under the floor, inside the plinth: the ground the unit stands on.
      expect(at(0, 0, 0)).toBe(false)
    })
  }
})
