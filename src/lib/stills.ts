import { CONTAINER_OPENINGS } from './products'
import { DEFAULT_CONFIG, ENVIRONMENTS, FINISHES, FLOORS, PACKAGES, type Config } from './config'
import { ANGLES, CAMERA_PRESETS, type AngleId } from './cameras'
import { effectiveLighting, effectiveLights } from './lighting'
import { renderKey } from './renderKey'

/**
 * How a still is assembled from pre-rendered layers.
 *
 * - `full`: one opaque image. Angles that never see inside, and the interior angles.
 * - `shell` over `interior`: exterior angles that see through the glazing or opening. The shell
 *   layer is the exterior with alpha where the inside shows through (glass keeps its reflection
 *   at the glass's opacity); the interior layer is what is seen through it. Stacking two images
 *   in the browser turns hundreds of thousands of combinations into tens of thousands of layers.
 */
export type LayerKind = 'full' | 'shell' | 'interior'

/** What the render worker draws for one layer. */
export type RenderSpec = { kind: LayerKind; angle: AngleId; config: Config }
export type Layer = RenderSpec & { key: string }

const studioAddons = (c: Config) =>
  c.family === 'studio' ? c.addons : { deck: false, gazebo: false, roof: false, stairs: false }

/** Lighting as the picture shows it: the studio is always day, lights are always on by day. */
function light(c: Config) {
  return {
    environment: c.environment,
    lighting: effectiveLighting(c),
    lights: effectiveLights(c),
  }
}

/** Everything that changes the outside of the unit and its surroundings. */
function shellFields(c: Config) {
  return {
    ...light(c),
    family: c.family,
    length: c.length,
    finish: c.finish,
    accent: c.family === 'studio' && c.accent,
    addons: studioAddons(c),
    containerOpening: c.containerOpening,
    integratedFinish: c.integratedFinish,
  }
}

/** Everything that changes the room as seen from outside, through the glazing or the opening. */
function interiorFields(c: Config) {
  return {
    ...light(c),
    family: c.family,
    length: c.length,
    // The interior reads the finish only to choose chalk or standard paint.
    chalk: c.finish === 'chalk',
    containerOpening: c.containerOpening,
    flooring: c.flooring,
    package: c.package,
    mirror: c.mirror,
  }
}

/**
 * From inside: the room, the gazebo's shade on it, and, looking out through the glazing, the
 * front deck.
 */
function interiorViewFields(c: Config, angle: AngleId) {
  const addons = studioAddons(c)
  return {
    ...interiorFields(c),
    gazebo: addons.gazebo,
    deck: angle === 'interiorReverse' && addons.deck,
  }
}

/**
 * The configuration the worker renders for a layer: the given one with every field the layer
 * cannot show reset to its default, so all configurations sharing a key share one render.
 */
function representative(c: Config, angle: AngleId, kind: LayerKind): Config {
  const interiorView = CAMERA_PRESETS[angle].view === 'interior'
  const base: Config = {
    ...DEFAULT_CONFIG,
    family: c.family,
    length: c.length,
    containerOpening: c.containerOpening,
    environment: c.environment,
    lighting: effectiveLighting(c),
    lights: effectiveLights(c),
  }
  if (kind === 'shell' || (kind === 'full' && !interiorView))
    return {
      ...base,
      finish: c.finish,
      accent: c.family === 'studio' && c.accent,
      addons: studioAddons(c),
      integratedFinish: c.integratedFinish,
    }
  const addons = studioAddons(c)
  return {
    ...base,
    finish: c.finish === 'chalk' ? 'chalk' : DEFAULT_CONFIG.finish,
    flooring: c.flooring,
    package: c.package,
    mirror: c.mirror,
    addons: {
      deck: angle === 'interiorReverse' && addons.deck,
      gazebo: interiorView && addons.gazebo,
      roof: false,
      stairs: false,
    },
  }
}

function layer(c: Config, angle: AngleId, kind: LayerKind): Layer {
  const interiorView = CAMERA_PRESETS[angle].view === 'interior'
  const fields =
    kind === 'shell' || (kind === 'full' && !interiorView)
      ? shellFields(c)
      : interiorView
        ? interiorViewFields(c, angle)
        : interiorFields(c)
  return {
    kind,
    angle,
    config: representative(c, angle, kind),
    key: renderKey({ kind, angle, ...fields }),
  }
}

/** The layers of one still, bottom first. */
export function layersFor(c: Config, angle: AngleId): Layer[] {
  const preset = CAMERA_PRESETS[angle]
  if (preset.view === 'interior' || !preset.seesInterior) return [layer(c, angle, 'full')]
  return [layer(c, angle, 'interior'), layer(c, angle, 'shell')]
}

/** Every configuration that can produce a distinct picture (layout inquiries never do). */
export function* everyConfiguration(): Generator<Config> {
  const bools = [false, true]
  for (const family of ['studio', 'container'] as const)
    for (const length of [20, 40] as const)
      for (const finish of FINISHES.map((f) => f.id))
        for (const opening of family === 'studio'
          ? (['roll-up'] as const)
          : CONTAINER_OPENINGS.map((o) => o.id))
          for (const integratedFinish of family === 'studio' ? [false] : bools)
            for (const accent of family === 'studio' ? bools : [false])
              for (const deck of family === 'studio' ? bools : [false])
                for (const gazebo of family === 'studio' ? bools : [false])
                  for (const roof of family === 'studio' ? bools : [false])
                    for (const stairs of family === 'studio' ? bools : [false])
                      for (const flooring of FLOORS.map((f) => f.id))
                        for (const pkg of PACKAGES.map((p) => p.id))
                          for (const mirror of bools)
                            for (const environment of ENVIRONMENTS.map((e) => e.id))
                              for (const lighting of environment === 'studio'
                                ? (['day'] as const)
                                : (['day', 'night'] as const))
                                for (const lights of lighting === 'day' ? [true] : bools)
                                  yield {
                                    ...DEFAULT_CONFIG,
                                    family,
                                    length,
                                    finish,
                                    containerOpening: opening,
                                    integratedFinish,
                                    accent,
                                    addons: { deck, gazebo, roof, stairs },
                                    flooring,
                                    package: pkg,
                                    mirror,
                                    environment,
                                    lighting,
                                    lights,
                                  }
}

/**
 * Every layer any configuration can need, deduplicated by key, in a stable order. Fields a layer
 * cannot show collapse: the rear of every interior choice is one image, and so on.
 */
export function enumerateLayers(angles: readonly AngleId[] = ANGLES): Layer[] {
  const layers = new Map<string, Layer>()
  for (const c of everyConfiguration())
    for (const angle of angles)
      for (const l of layersFor(c, angle)) if (!layers.has(l.key)) layers.set(l.key, l)
  return [...layers.values()]
}
