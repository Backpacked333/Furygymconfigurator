import { freezeDesignValue, parseDesign, projectDesignToConfig } from '../../domain/design'
import { resolveCamera } from '../../domain/presentation'
import { sha256Text } from '../../domain/designIdentity'
import { displayProfileFor, stableDisplayJson } from '../../display/contract'
import { resolvePrivateThreeCamera } from '../prototype/privateScene'

/** Display-specific full-quality projection, not a relabelled Lite recipe. */
export function displaySceneInput(input: unknown) {
  const design = parseDesign(input)
  return freezeDesignValue({
    design,
    config: projectDesignToConfig(design),
    camera: resolvePrivateThreeCamera(design),
    view: resolveCamera(design.presentation.cameraRef).group,
    profile: displayProfileFor(design),
  })
}
export function displayCameraDigest(input: unknown) {
  return sha256Text(stableDisplayJson(resolvePrivateThreeCamera(input)))
}
