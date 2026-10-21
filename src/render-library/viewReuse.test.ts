// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  defaultDesign,
  hasOperableDoor,
  parseDesign,
  serializeDesign,
  type DesignEnvelope,
} from '../domain/design'
import { computeSetIdentity, verifyImageDescriptor } from './identity'
import {
  CUSTOMER_CAMERA_REFS,
  normalizeCustomerDesign,
  viewDesign,
  type CustomerCameraRef,
} from './views'
import { seedImagesForSet } from './server/seedCache'
import { readFileSync } from 'node:fs'
import { FINISHES, FLOORS, INTERIORS } from '../lib/config'
import { DRAFT_LOOKS } from '../domain/presentation'
import { CONTAINER_OPENINGS, OPENING_INFILLS, STUDIO_DOORS } from '../lib/products'

const rear = 'rear-left-draft@1'
const opaque: readonly CustomerCameraRef[] = ['left-draft@1', rear]
const products = [
  { family: 'studio', lengthFt: 20 },
  { family: 'studio', lengthFt: 40 },
  { family: 'container', lengthFt: 20 },
  { family: 'container', lengthFt: 40 },
] as const
const roomVariant = (design: DesignEnvelope) =>
  parseDesign({
    ...design,
    config: {
      ...design.config,
      appearance: { ...design.config.appearance, interior: 'timber', floor: 'oak', mirror: true },
    },
  })

describe('camera-visible photographic representatives', () => {
  it.each(products)(
    'shares only the opaque studio-background end/rear room for $family $lengthFt',
    async (product) => {
      const base = normalizeCustomerDesign(defaultDesign(product))
      for (const look of DRAFT_LOOKS) {
        const design = parseDesign({
          ...base,
          presentation: { ...base.presentation, lookRef: look.ref },
        })
        const variant = roomVariant(design)
        const [a, b] = await Promise.all([computeSetIdentity(design), computeSetIdentity(variant)])
        expect(a.setKey).not.toBe(b.setKey)
        for (const camera of CUSTOMER_CAMERA_REFS) {
          const shared = opaque.includes(camera) && look.ref.startsWith('studio-')
          expect(b.imageKeys[camera] === a.imageKeys[camera]).toBe(shared)
          expect(serializeDesign(viewDesign(viewDesign(variant, camera), camera))).toBe(
            serializeDesign(viewDesign(variant, camera)),
          )
        }
      }
    },
  )

  it.each(products)(
    'retains all room combinations for front/entry of $family $lengthFt',
    async (product) => {
      const base = normalizeCustomerDesign(defaultDesign(product))
      const seen = Object.fromEntries(
        CUSTOMER_CAMERA_REFS.map((camera) => [camera, new Set<string>()]),
      )
      for (const interior of INTERIORS)
        for (const floor of FLOORS)
          for (const mirror of [false, true]) {
            const design = parseDesign({
              ...base,
              config: {
                ...base.config,
                appearance: {
                  ...base.config.appearance,
                  interior: interior.id,
                  floor: floor.id,
                  mirror,
                },
              },
            })
            const identity = await computeSetIdentity(design)
            for (const camera of CUSTOMER_CAMERA_REFS) seen[camera].add(identity.imageKeys[camera])
          }
      for (const camera of CUSTOMER_CAMERA_REFS)
        expect(seen[camera].size).toBe(
          opaque.includes(camera) ? 1 : INTERIORS.length * FLOORS.length * 2,
        )
    },
  )

  it.each(products.flatMap((product) => opaque.map((camera) => ({ ...product, camera }))))(
    'does not collapse shadows, reflections or framing for $family $lengthFt $camera',
    async ({ camera, ...product }) => {
      const base = normalizeCustomerDesign(defaultDesign(product))
      const original = (await computeSetIdentity(base)).imageKeys[camera]
      for (const look of DRAFT_LOOKS)
        if (look.ref !== base.presentation.lookRef)
          expect(
            (
              await computeSetIdentity({
                ...base,
                presentation: { ...base.presentation, lookRef: look.ref },
              })
            ).imageKeys[camera],
          ).not.toBe(original)
      for (const finish of FINISHES)
        if (finish.id !== base.config.appearance.finish)
          expect(
            (
              await computeSetIdentity({
                ...base,
                config: {
                  ...base.config,
                  appearance: { ...base.config.appearance, finish: finish.id },
                },
              })
            ).imageKeys[camera],
          ).not.toBe(original)
      expect(
        (
          await computeSetIdentity({
            ...base,
            presentation: { ...base.presentation, aspect: 'tall' },
          })
        ).imageKeys[camera],
      ).not.toBe(original)
      for (const addons of [['roof'], ['stairs'], ['deck']]) {
        const design = parseDesign({
          ...base,
          config: { ...base.config, structure: { ...base.config.structure, addons } },
        })
        const [a, b] = await Promise.all([
          computeSetIdentity(design),
          computeSetIdentity(roomVariant(design)),
        ])
        expect(a.imageKeys[camera]).not.toBe(original)
        expect(b.imageKeys[camera]).not.toBe(a.imageKeys[camera])
      }
    },
  )

  it('shares unused railings but retains modeled railing geometry', async () => {
    const base = defaultDesign()
    for (const addons of [[], ['deck'], ['roof'], ['stairs']]) {
      const a = parseDesign({
        ...base,
        config: { ...base.config, structure: { ...base.config.structure, addons } },
      })
      const b = parseDesign({
        ...a,
        config: { ...a.config, structure: { ...a.config.structure, railing: 'cable' } },
      })
      const [first, second] = await Promise.all([computeSetIdentity(a), computeSetIdentity(b)])
      for (const camera of CUSTOMER_CAMERA_REFS)
        expect(first.imageKeys[camera] === second.imageKeys[camera]).toBe(
          camera === 'entry-draft@1' || !addons.some((addon) => ['roof', 'stairs'].includes(addon)),
        )
    }
  })

  it.each(products)(
    'preserves door, glass, openings, trim and size for $family $lengthFt',
    async (product) => {
      const base = normalizeCustomerDesign(defaultDesign(product))
      const variants: unknown[] = [
        normalizeCustomerDesign(
          defaultDesign({ ...product, lengthFt: product.lengthFt === 20 ? 40 : 20 }),
        ),
      ]
      const structure = base.config.structure
      if (structure.kind === 'studio') {
        variants.push({
          ...base,
          config: { ...base.config, appearance: { ...base.config.appearance, accent: true } },
        })
        variants.push({ ...base, presentation: { ...base.presentation, doorPose: 'open' } })
        for (const door of STUDIO_DOORS)
          if (door.id !== structure.door)
            variants.push({
              ...base,
              config: { ...base.config, structure: { ...structure, door: door.id } },
            })
      } else {
        variants.push({
          ...base,
          config: {
            ...base.config,
            structure: { ...structure, integratedFinish: !structure.integratedFinish },
          },
        })
        for (const opening of CONTAINER_OPENINGS)
          if (opening.id !== structure.opening)
            variants.push(
              normalizeCustomerDesign({
                ...base,
                presentation: { ...base.presentation, doorPose: 'closed' },
                config: { ...base.config, structure: { ...structure, opening: opening.id } },
              }),
            )
        const center = normalizeCustomerDesign({
          ...base,
          presentation: { ...base.presentation, doorPose: 'closed' },
          config: { ...base.config, structure: { ...structure, opening: 'center' } },
        })
        const centerIdentity = await computeSetIdentity(center)
        for (const infill of OPENING_INFILLS) {
          if (infill.id === structure.infill) continue
          const glazedStructure = { ...center.config.structure, infill: infill.id }
          const glazedIdentity = await computeSetIdentity({
            ...center,
            presentation: {
              ...center.presentation,
              doorPose: hasOperableDoor(glazedStructure) ? 'open' : 'closed',
            },
            config: {
              ...center.config,
              structure: glazedStructure,
            },
          })
          for (const camera of CUSTOMER_CAMERA_REFS.filter((c) => c !== 'entry-draft@1'))
            expect(glazedIdentity.imageKeys[camera]).not.toBe(centerIdentity.imageKeys[camera])
        }
      }
      const identity = await computeSetIdentity(base)
      for (const variant of variants) {
        const next = await computeSetIdentity(variant)
        for (const camera of CUSTOMER_CAMERA_REFS.filter((c) => c !== 'entry-draft@1'))
          expect(next.imageKeys[camera]).not.toBe(identity.imageKeys[camera])
      }
    },
  )

  it('reuses only an exact historical canonical descriptor without rewriting its provenance', async () => {
    const design = defaultDesign()
    const variant = roomVariant(design)
    const bytes = readFileSync('public/native-library/manifest.json')
    const images = await seedImagesForSet(bytes, variant)
    const image = images.find((entry) => entry.design.presentation.cameraRef === rear)!
    expect(image).toBeDefined()
    expect(image.design).toEqual(viewDesign(variant, rear))
    const historical = (await seedImagesForSet(bytes, design)).find(
      (entry) => entry.imageKey === image.imageKey,
    )!
    expect(image.provenance).toEqual(historical.provenance)
    expect(image.sha256).toBe(historical.sha256)
    expect(await verifyImageDescriptor(historical, variant, [])).toEqual(historical)
    await expect(
      verifyImageDescriptor(
        { ...historical, design: { ...historical.design, config: variant.config } },
        variant,
        [],
      ),
    ).rejects.toThrow('Wrong image design')
  })

  it('matches the real Python worker projection and every image identity', async () => {
    const vectors = []
    for (const product of products)
      for (const look of DRAFT_LOOKS)
        for (const addons of [[], ['roof']]) {
          const base = roomVariant(normalizeCustomerDesign(defaultDesign(product)))
          const design = parseDesign({
            ...base,
            config: { ...base.config, structure: { ...base.config.structure, addons } },
            presentation: { ...base.presentation, lookRef: look.ref },
          })
          vectors.push({
            design,
            identity: await computeSetIdentity(design),
            views: CUSTOMER_CAMERA_REFS.map((camera) => viewDesign(design, camera)),
          })
        }
    execFileSync(
      'python3',
      [
        '-c',
        `
import json, runpy, sys
v = runpy.run_path("render-server/on_demand/validation.py")
for row in json.load(sys.stdin):
    d, ident = row["design"], row["identity"]
    assert v["identity"](d, "set", ident["recipeRelease"]) == ident["setKey"]
    for expected in row["views"]:
        camera = expected["presentation"]["cameraRef"]
        actual = v["view_design"](d, camera)
        assert actual == expected
        assert v["identity"](actual, "image", ident["recipeRelease"]) == ident["imageKeys"][camera]
`,
      ],
      { input: JSON.stringify(vectors), encoding: 'utf8' },
    )
  })
})
