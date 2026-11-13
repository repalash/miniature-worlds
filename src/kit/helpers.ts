import {ITexture, LinearSRGBColorSpace, ProgressivePlugin, RepeatWrapping, SRGBColorSpace, ThreeViewer, TonemapPlugin, ToneMapping} from 'threepipe'
import {BloomPlugin, SSGIPlugin, SSReflectionPlugin} from '@threepipe/webgi-plugins'
import {asset} from './assets'

/** Small helpers shared by the kit and the tiles: plugin presets, the camera, Poly Haven files. */

export type V3 = [number, number, number]

export interface PluginPreset {
    ssgi?: Record<string, any>
    ssr?: Record<string, any>
    bloom?: Record<string, any>
    tonemap?: {toneMapping?: ToneMapping, exposure?: number, saturation?: number, contrast?: number}
    progressiveFrames?: number
}

/** Plugin settings of a scene. Applied after any viewer config embedded in a loaded file. */
export function configure(viewer: ThreeViewer, p: PluginPreset) {
    const ssgi = viewer.getPlugin(SSGIPlugin)
    if (ssgi && p.ssgi) {
        ssgi.enabled = true
        Object.assign(ssgi.pass!, p.ssgi)
        ssgi.pass!.setDirty()
    }
    const ssr = viewer.getPlugin(SSReflectionPlugin)
    if (ssr && p.ssr) {
        ssr.enabled = true
        Object.assign(ssr.pass!, p.ssr)
        ssr.pass!.setDirty()
    }
    const bloom = viewer.getPlugin(BloomPlugin)
    if (bloom && p.bloom) {
        bloom.enabled = true
        Object.assign(bloom.pass!, p.bloom)
        bloom.pass!.setDirty()
    }
    const tonemap = viewer.getPlugin(TonemapPlugin)
    if (tonemap && p.tonemap) {
        Object.assign(tonemap, p.tonemap)
        tonemap.setDirty()
    }
    const progressive = viewer.getPlugin(ProgressivePlugin)
    if (progressive && p.progressiveFrames) progressive.maxFrameCount = p.progressiveFrames
    viewer.setDirty()
}

/** Poly Haven HDRI (CC0), 1k. */
export const polyHavenHdri = (id: string) => asset(`https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/${id}_1k.hdr`)

/** Poly Haven PBR texture set (CC0), 1k jpg. Returns the maps with repeat wrapping. */
export async function polyHavenTexture(viewer: ThreeViewer, id: string, repeat: [number, number]) {
    const base = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${id}`
    const load = async(suffix: string, srgb: boolean) => {
        const t = await viewer.load<ITexture>(asset(`${base}_${suffix}_1k.jpg`)).catch(() => undefined)
        if (!t) return undefined
        t.wrapS = t.wrapT = RepeatWrapping
        t.repeat.set(...repeat)
        t.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace
        t.anisotropy = 8
        t.needsUpdate = true
        return t
    }
    const [map, roughnessMap, normalMap] = await Promise.all([load('diff', true), load('rough', false), load('nor_gl', false)])
    return {map, roughnessMap, normalMap}
}

export function setCamera(viewer: ThreeViewer, position: V3, target: V3, fov?: number) {
    const cam = viewer.scene.mainCamera as any
    cam.position.set(...position)
    cam.target.set(...target)
    if (fov) cam.fov = fov
    cam.lookAt(cam.target)
    cam.setDirty()
}

/** Sets a fixed near/far range for scenes much larger or smaller than a product (auto near/far frames the bounds). */
export function cameraRange(viewer: ThreeViewer, near: number, far: number) {
    const cam = viewer.scene.mainCamera as any
    cam.autoNearFar = false
    cam.near = near
    cam.far = far
    cam.updateProjectionMatrix()
}
