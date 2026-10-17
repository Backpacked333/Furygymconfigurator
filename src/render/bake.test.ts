// @vitest-environment jsdom
import { Matrix4, Vector3 } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CAMERA, DEFAULT_CONFIG, SIGNATURES } from '../lib/config'
import { configKey, stillKey } from '../lib/stillKey'
import { QUICK_LONG_EDGE, QUICK_QUALITY, bakeJobs } from './bake'
import { GALLERY_ANGLES, angleKey, galleryCamera } from './gallery'
import { QUALITY } from './stills'

const lens = { near: 0.1, far: 2000 }

describe('a bake', () => {
  it('asks for every angle at every stage shape, at the export tier', () => {
    const jobs = bakeJobs({
      config: DEFAULT_CONFIG,
      hero: DEFAULT_CAMERA,
      aspects: ['wide', 'tall'],
      ...lens,
    })
    expect(jobs).toHaveLength(GALLERY_ANGLES.length * 2)
    const ids = GALLERY_ANGLES.map((a) => a.id)
    expect(jobs.map((j) => `${j.angle}/${j.aspect}`)).toEqual([
      ...ids.map((id) => `${id}/wide`),
      ...ids.map((id) => `${id}/tall`),
    ])
    expect(jobs.every((j) => j.quality === QUALITY.export)).toBe(true)
    // The export's size, in the stage's shape.
    expect(jobs.filter((j) => j.aspect === 'wide').map((j) => [j.width, j.height])).toEqual(
      ids.map(() => [2400, 1500]),
    )
    expect(jobs.filter((j) => j.aspect === 'tall').map((j) => [j.width, j.height])).toEqual(
      ids.map(() => [1920, 2400]),
    )
    expect(jobs.map((j) => j.part)).toEqual(
      [...GALLERY_ANGLES, ...GALLERY_ANGLES].map((a) => a.group),
    )
  })

  it('keys each still from the design alone, as the stage looks it up', () => {
    const design = configKey(DEFAULT_CONFIG)
    const jobs = bakeJobs({
      config: DEFAULT_CONFIG,
      hero: DEFAULT_CAMERA,
      aspects: ['wide'],
      ...lens,
    })
    expect(jobs.map((j) => j.key)).toEqual(
      GALLERY_ANGLES.map(({ id }) => stillKey(design, id, 'wide')),
    )
    // A signature build is framed from its photograph: its front ¾ view says so in its key.
    const signature = SIGNATURES[0]
    const own = bakeJobs({
      config: signature.config,
      hero: signature.camera,
      aspects: ['tall'],
      ...lens,
    })
    expect(own[0].angleKey).toBe(angleKey('front-left', signature.camera))
    expect(own[0].angleKey).not.toBe('front-left')
    expect(own[0].key).toBe(
      stillKey(configKey(signature.config), angleKey('front-left', signature.camera), 'tall'),
    )
    expect(own[1].angleKey).toBe('front')
  })

  it("renders from the stage's own cameras", () => {
    const [job] = bakeJobs({
      config: DEFAULT_CONFIG,
      hero: DEFAULT_CAMERA,
      aspects: ['tall'],
      ...lens,
    })
    const shot = galleryCamera(DEFAULT_CONFIG, 'front-left', 'tall', DEFAULT_CAMERA)
    const eye = new Vector3().setFromMatrixPosition(new Matrix4().fromArray(job.camera.matrix))
    expect(eye.toArray()).toEqual(shot.position.map((v) => expect.closeTo(v, 6)))
    expect(job.camera).toMatchObject({ fov: shot.fov, ...lens })
  })

  it('makes a quick bake small and quick', () => {
    const jobs = bakeJobs({
      config: DEFAULT_CONFIG,
      hero: DEFAULT_CAMERA,
      aspects: ['wide', 'tall'],
      ...lens,
      quick: true,
    })
    expect(jobs).toHaveLength(18)
    expect(jobs.every((j) => j.quality === QUICK_QUALITY && j.quality.samples === 64)).toBe(true)
    expect([jobs[0].width, jobs[0].height]).toEqual([QUICK_LONG_EDGE, 400])
    expect([jobs[17].width, jobs[17].height]).toEqual([512, QUICK_LONG_EDGE])
  })
})
