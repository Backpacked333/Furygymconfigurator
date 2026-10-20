import { createContext } from 'react'

/**
 * Whether the scene's part lists share their merged geometry by content (parts.ts
 * `cachedBatches`), so that an edit rebuilding a list to the same shapes keeps its meshes and
 * their geometry and only swaps materials. The path tracer then reads the edit as new materials,
 * not as a new scene, and updates them in place instead of building its BVH again.
 *
 * Only the library's live 360° view turns it on (LiveDesignScene). The stills and exports keep
 * their meshes rebuilt and their geometry merged afresh for each edit, as they were made. It lives
 * here rather than beside Parts, so the private browser builds' module gates admit it.
 */
export const GeometryReuse = createContext(false)
