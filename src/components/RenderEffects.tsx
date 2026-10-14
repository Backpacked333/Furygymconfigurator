import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { HalfFloatType, Mesh, WebGLRenderTarget, type Object3D } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js'

class InteriorOcclusionPass extends SSAOPass {
  override render(...args: Parameters<SSAOPass['render']>) {
    const hidden: Object3D[] = []
    // Glazing must not hide the interior from the depth/normal pass.
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh) || !object.visible) return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      if (materials.some((material) => material.transparent)) {
        hidden.push(object)
        object.visible = false
      }
    })
    try {
      super.render(...args)
    } finally {
      hidden.forEach((object) => (object.visible = true))
    }
  }
}

export function RenderEffects({
  quality,
  onCaptureReady,
}: {
  quality: 'high' | 'lite'
  onCaptureReady: (capture: () => string) => void
}) {
  const { gl, scene, camera, size, viewport, invalidate } = useThree()
  const composer = useRef<EffectComposer | null>(null)

  useEffect(() => {
    if (quality !== 'high') return
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 })
    const pipeline = new EffectComposer(gl, target)
    const beauty = new RenderPass(scene, camera)
    const occlusion = new InteriorOcclusionPass(scene, camera, 1, 1, 16)
    occlusion.kernelRadius = 0.75
    occlusion.minDistance = 0.0003
    occlusion.maxDistance = 0.006
    const output = new OutputPass()
    pipeline.addPass(beauty)
    pipeline.addPass(occlusion)
    pipeline.addPass(output)
    composer.current = pipeline
    invalidate()
    return () => {
      composer.current = null
      beauty.dispose()
      occlusion.dispose()
      output.dispose()
      pipeline.dispose()
    }
  }, [gl, scene, camera, quality, invalidate])

  useEffect(() => {
    composer.current?.setPixelRatio(viewport.dpr)
    composer.current?.setSize(size.width, size.height)
    invalidate()
  }, [size.width, size.height, viewport.dpr, quality, invalidate])

  useEffect(() => {
    onCaptureReady(() => {
      if (composer.current) composer.current.render(0)
      else gl.render(scene, camera)
      return gl.domElement.toDataURL('image/png')
    })
  }, [gl, scene, camera, onCaptureReady])

  useFrame((_, delta) => {
    if (composer.current) composer.current.render(delta)
    else gl.render(scene, camera)
  }, 1)
  return null
}
