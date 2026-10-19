import { Children, isValidElement } from 'react'
import { PerspectiveCamera } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { Atmosphere } from '../../../../components/Atmosphere'
import { InteriorProbe, SiteProbe } from '../../../../components/InteriorProbe'
import { Landscape } from '../../../../components/Landscape'
import { StudioModel } from '../../../../components/StudioModel'
import { projectDesignToConfig } from '../../../../domain/design'
import { resolveCamera } from '../../../../domain/presentation'
import { CAPTURE_EFFECTS, createCaptureSamples, resolveCaptureCamera } from '../contract'
import { CaptureAssembly, assertMountedCamera, effectReceipt } from './scene'

/** Component graph/props tests only: no React mount, DOM, WebGL, PNG fixture or renderer claim. */
describe('trusted fixed browser assembly', () => {
  it.each(createCaptureSamples())(
    'uses the authored scene builders for $id without app/store/placement input',
    (sample) => {
      const config = projectDesignToConfig(sample.request.design)
      const view = resolveCamera(sample.request.design.presentation.cameraRef).group
      const children = Children.toArray(CaptureAssembly({ config, view }).props.children)
      expect(children).toHaveLength(6)
      const builders = [Atmosphere, Landscape, StudioModel, InteriorProbe, SiteProbe]
      builders.forEach((builder, index) => {
        const child = children[index]
        expect(isValidElement(child)).toBe(true)
        if (!isValidElement<{ config: typeof config; quality: string; view?: string }>(child))
          throw new Error('Missing authored builder')
        expect(child.type).toBe(builder)
        expect(child.props.config).toBe(config)
        expect(child.props.quality).toBe('lite')
        if (index === 0) expect(child.props.view).toBe(view)
      })
      expect(config.doorsOpen).toBe(sample.request.design.presentation.doorPose === 'open')
      expect(config.items.length).toBeGreaterThan(0)
      // Frozen six compositions are outdoor looks; their settle gate requires two site-environment captures.
      expect(config.environment).not.toBe('studio')
      const camera = resolveCaptureCamera(sample.request.design)
      expect(camera).toMatchObject({ up: [0, 1, 0], near: 0.1, far: 2000, units: 'feet' })
    },
  )
  it.each(['position', 'rotation', 'fov', 'projection', 'zoom'])(
    'rejects mounted camera %s drift instead of echoing a valid pose',
    (drift) => {
      const sample = createCaptureSamples()[0]
      const pose = resolveCaptureCamera(sample.request.design)
      const camera = new PerspectiveCamera(pose.fov, 1.6, pose.near, pose.far)
      camera.position.set(...pose.position)
      camera.up.set(...pose.up)
      camera.lookAt(...pose.target)
      camera.updateMatrixWorld()
      expect(() => assertMountedCamera(camera, pose, 1.6)).not.toThrow()
      if (drift === 'position') camera.position.x += 0.001
      if (drift === 'rotation') camera.rotation.y += 0.001
      if (drift === 'fov') camera.fov += 0.001
      if (drift === 'projection') camera.projectionMatrix.elements[0] += 0.001
      if (drift === 'zoom') camera.zoom = 2
      expect(() => assertMountedCamera(camera, pose, 1.6)).toThrow()
    },
  )
  it.each(createCaptureSamples())('has complete honest effect receipts for $id', (sample) => {
    const config = projectDesignToConfig(sample.request.design)
    const effects = effectReceipt(config)
    expect(effects.map((effect) => effect.id)).toEqual(CAPTURE_EFFECTS)
    const byId = Object.fromEntries(effects.map((effect) => [effect.id, effect]))
    for (const id of [
      'ambient-occlusion',
      'screen-space-gi',
      'screen-space-reflections',
      'bloom',
      'path-tracing',
    ])
      expect(byId[id].state).toBe('omitted')
    expect(byId['site-light-field'].state).toBe('approximate')
    expect(byId['thin-glass'].state).toBe('approximate')
    expect(byId.mirror.state).toBe(config.mirror ? 'approximate' : 'not-applicable')
    expect(byId['signature-canvas'].state).toBe(
      config.family === 'studio' ? 'approximate' : 'not-applicable',
    )
    expect(byId.msaa.detail).toContain('requests 4x MSAA')
    expect(byId['material-textures'].detail).toContain('rights')
  })
})
