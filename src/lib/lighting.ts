import type { Config, Lighting } from './config'

/**
 * The two lighting moods, as times on the artistic sun path: a low late-afternoon sun, and the
 * blue hour after sunset, when the sky still separates the building from the night.
 */
export const LIGHTING_TIME: Record<Lighting, number> = { day: 16.5, night: 20.9 }

/** The studio backdrop is lit like a photo studio: always day. */
export function effectiveLighting(c: Pick<Config, 'environment' | 'lighting'>): Lighting {
  return c.environment === 'studio' ? 'day' : c.lighting
}

/** Architectural lighting is always on by day; the toggle chooses it after dark. */
export function effectiveLights(c: Pick<Config, 'environment' | 'lighting' | 'lights'>) {
  return effectiveLighting(c) === 'day' ? true : c.lights
}

/** The sun-path time the scene is lit for. */
export function sceneTime(c: Pick<Config, 'environment' | 'lighting'>) {
  return LIGHTING_TIME[effectiveLighting(c)]
}
