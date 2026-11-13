import {
    ACESFilmicToneMapping,
    CanvasTexture,
    Color,
    ColorRepresentation,
    FogExp2,
    SRGBColorSpace,
    ThreeViewer,
    ToneMapping,
    TonemapPlugin,
    Vector3,
    VignettePlugin,
} from 'threepipe'
import {DepthOfFieldPlugin} from '@threepipe/webgi-plugins'
import {ColorGradePlugin} from './grade'
import {configure, PluginPreset, polyHavenHdri, setCamera} from './helpers'
import type {LightingPreset, LightingRig} from './lighting'

/**
 * The look shared by the world scenes, after Unreal defaults and the reference clip
 * (https://x.com/mlperego/status/2105448230616023446): one hard sun key, a low sky fill so the bounce stays
 * visible, filmic (ACES) tone mapping slightly under-exposed so highlights roll off, depth of field on the subject,
 * no vignette or grain, and either a neutral studio backdrop (diorama) or the sky.
 */
export interface WorldLook {
    /**
     * Poly Haven HDRI id used as sky fill (and background with `background: 'sky'`), or a texture the scene made
     * itself (a procedural sky): `environment` lights the scene, `background` (default: the same) is the backdrop.
     */
    sky: string | {environment: any, background?: any}
    /** Environment (sky fill) intensity; 0.1 to 0.3 keeps GI visible. */
    fill: number
    /** 'studio' = radial grey gradient (diorama), 'sky' = the HDRI, or a color. */
    background?: 'studio' | 'sky' | ColorRepresentation
    backgroundIntensity?: number
    sun: NonNullable<LightingPreset['sun']>
    /** Region the sun's shadow covers. */
    fit: {center: [number, number, number], radius: number}
    /**
     * How the HDRI lights the scene (see {@link litSky}): a ground painted into its lower half, and a saturation trim
     * of the sky light so shade is not tinted deep blue. The visible sky keeps the original image.
     */
    skyLight?: SkyLight
    /** Rotate the HDRI so its painted sun matches the scene's sun (default true). */
    alignSky?: boolean
    /** Exponential fog: color and density per meter. */
    fog?: {color: ColorRepresentation, density: number}
    exposure?: number
    toneMapping?: ToneMapping
    /**
     * Depth of field, focused on the camera target (follows every view and camera path, like an autofocus).
     * `range`: the in-focus depth as a fraction of the focus distance; `near`, `far`: blur strength (0 to 1).
     */
    dof?: {range?: number, near?: number, far?: number}
    /** Split toning and saturation after tone mapping (see kit/grade.ts); `false` turns it off. */
    grade?: Parameters<ColorGradePlugin['set']>[0] | false
    /** Vignette strength (0 for none). */
    vignette?: number
    plugins?: PluginPreset
}

/** A radial gradient backdrop, like a product studio sweep. */
let studioTexture: CanvasTexture | undefined
export function studioBackdrop(inner = '#3e4450', outer = '#15161b') {
    if (studioTexture) return studioTexture
    const c = document.createElement('canvas')
    c.width = 1024
    c.height = 512
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(512, 160, 40, 512, 300, 720)
    g.addColorStop(0, inner)
    g.addColorStop(1, outer)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, c.width, c.height)
    const t = new CanvasTexture(c)
    t.colorSpace = SRGBColorSpace
    studioTexture = t
    return t
}

export async function stageWorld(viewer: ThreeViewer, rig: LightingRig, look: WorldLook) {
    const scene = viewer.scene
    skyLight = {...SKY_LIGHT, ...look.skyLight}
    let raw: any
    if (typeof look.sky === 'string') raw = await setSky(viewer, look.sky)
    else {
        scene.environment = look.sky.environment
        raw = look.sky.background ?? look.sky.environment
    }
    scene.environmentIntensity = look.fill
    if (look.background === 'sky') {
        scene.background = raw as any
        scene.backgroundIntensity = look.backgroundIntensity ?? 1
    } else if (look.background === 'studio' || look.background === undefined) {
        scene.background = studioBackdrop() as any
        scene.backgroundIntensity = look.backgroundIntensity ?? 1
    } else {
        scene.background = null
        scene.backgroundColor = new Color(look.background)
    }
    rig.apply({sun: {autoColor: false, ...look.sun}, environment: look.fill, movers: {enabled: false}, fit: look.fit})
    // The sky turns with the sun as the scene animates it, so the HDRI's sun and the shadows always agree.
    rig.onSunUpdate = look.alignSky === false ? undefined : () => rig.sunState.enabled && alignSky(viewer, rig.sunState.azimuth)
    if (look.alignSky !== false) alignSky(viewer, look.sun.azimuth ?? 0)
    configure(viewer, {
        ...look.plugins,
        tonemap: {toneMapping: look.toneMapping ?? ACESFilmicToneMapping, exposure: look.exposure ?? 1, ...look.plugins?.tonemap},
    })
    if (look.fog) setFog(viewer, look.fog.color, look.fog.density)
    const grade = viewer.getPlugin(ColorGradePlugin)
    if (grade) {
        grade.enabled = look.grade !== false
        if (look.grade) grade.set(look.grade)
        grade.setDirty()
    }
    const vignette = viewer.getPlugin(VignettePlugin)
    if (vignette) {
        vignette.enabled = (look.vignette ?? 0.12) > 0
        vignette.power = look.vignette ?? 0.12
        vignette.setDirty()
    }
    const dof = viewer.getPlugin(DepthOfFieldPlugin)
    if (dof) {
        dof.enabled = !!look.dof
        if (look.dof && dof.pass) {
            const o = look.dof, pass = dof.pass
            pass.nearBlurScale = o.near ?? 0.15
            pass.farBlurScale = o.far ?? 0.2
            const cam = viewer.scene.mainCamera as any
            const focus = new Vector3(Infinity, 0, 0)
            const update = () => {
                if (!dof.enabled) return
                const target = cam.target as Vector3
                if (focus.distanceToSquared(target) > 1e-6) {
                    focus.copy(target)
                    dof.setFocalPoint(focus, false)
                }
                pass.depthRange = Math.max(0.25, cam.position.distanceTo(target) * (o.range ?? 0.35))
            }
            viewer.addEventListener('preFrame', update)
            update()
        }
    }
    viewer.setDirty()
}

/** Exponential fog on every material in the scene (threepipe materials have fog off by default). */
export function setFog(viewer: ThreeViewer, color: ColorRepresentation, density: number) {
    const scene = viewer.scene as any
    scene.fog = new FogExp2(new Color(color).getHex(), density)
    scene.traverse((o: any) => {
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
        for (const m of ms) if (m && !m.fog) {
            m.fog = true
            m.needsUpdate = true
        }
    })
    viewer.setDirty()
}

/** A lighting preset of a world: sun, sky fill, exposure and grade (a time of day). */
export interface TimePreset {
    sun: {azimuth: number, elevation: number, intensity: number, kelvin: number}
    fill: number
    /** Poly Haven HDRI id for the sky fill (keeps the current one when omitted). */
    sky?: string
    exposure?: number
    /** Backdrop brightness; lower it when the exposure goes up at dusk and at night. */
    backgroundIntensity?: number
    grade?: Parameters<ColorGradePlugin['set']>[0]
}

/**
 * Applies a time-of-day preset. `base` is the scene's mutable sun state that its animation sweeps around; it is
 * updated so the sweep continues around the new sun.
 */
export async function applyTime(viewer: ThreeViewer, rig: LightingRig, p: TimePreset, base?: {azimuth: number, elevation: number}) {
    if (p.sky) {
        const bg = viewer.scene.background as any
        const raw = await setSky(viewer, p.sky)
        if (raw && bg?.userData?.__skyRaw) viewer.scene.background = raw as any
    }
    viewer.scene.environmentIntensity = p.fill
    viewer.scene.backgroundIntensity = p.backgroundIntensity ?? 1
    if (base) Object.assign(base, {azimuth: p.sun.azimuth, elevation: p.sun.elevation})
    Object.assign(rig.sunState, {enabled: p.sun.intensity > 0, autoColor: false, ...p.sun})
    rig.updateSun()
    const tonemap = viewer.getPlugin(TonemapPlugin)
    if (tonemap && p.exposure !== undefined) {
        tonemap.exposure = p.exposure
        tonemap.setDirty()
    }
    if (p.grade) viewer.getPlugin(ColorGradePlugin)?.set(p.grade)
    viewer.renderManager.resetShadows()
    viewer.setDirty()
}

const half = (h: number) => {
    const e = (h >> 10) & 31, m = h & 1023, s = h >> 15 ? -1 : 1
    return s * (e === 0 ? m * 5.960464477539063e-8 : e === 31 ? 65504 : Math.pow(2, e - 15) * (1 + m / 1024))
}

/**
 * Direction of the sun in an equirectangular HDRI (its brightest pixel), in the rig's convention: azimuth in
 * degrees around +y from +x toward +z, elevation in degrees. null when the image data is not readable.
 */
export function hdriSun(tex: any): {azimuth: number, elevation: number} | null {
    if (tex?.userData?.__hdriSun !== undefined) return tex.userData.__hdriSun
    const img = tex?.image
    const data = img?.data, w = img?.width, h = img?.height
    if (!data || !w || !h) return null
    const stride = data.length / (w * h)
    const read = data instanceof Uint16Array ? half : (x: number) => x
    let best = -1, bx = 0, by = 0
    for (let y = 0; y < h / 2; y++) for (let x = 0; x < w; x++) {
        const k = (y * w + x) * stride
        const l = read(data[k]) * 0.2126 + read(data[k + 1]) * 0.7152 + read(data[k + 2]) * 0.0722
        if (l > best) { best = l; bx = x; by = y }
    }
    // three.js equirect lookup: u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5; the loader flips rows (row 0 = top).
    const u = (bx + 0.5) / w, v = tex.flipY === false ? (by + 0.5) / h : 1 - (by + 0.5) / h
    const sun = {azimuth: (u - 0.5) * 360, elevation: (v - 0.5) * 180}
    if (tex.userData) tex.userData.__hdriSun = sun
    return sun
}

/**
 * Rotates the sky (environment and background) so the sun painted in the HDRI stands where the scene's sun is, so the
 * shadows agree with the sky. `sign` flips the rotation direction if a build of three.js turns the other way.
 */
export function alignSky(viewer: ThreeViewer, sunAzimuth: number, sign = 1) {
    const scene = viewer.scene as any
    const sun = hdriSun(scene.environment)
    if (!sun) return
    const rot = sign * (sun.azimuth - sunAzimuth) * Math.PI / 180
    scene.environmentRotation?.set(0, rot, 0)
    scene.backgroundRotation?.set(0, rot, 0)
    viewer.setDirty()
}

/** A named view: sets the backdrop (sky at eye level, studio for a diorama), then the camera. */
export function view(viewer: ThreeViewer, bg: 'sky' | 'studio', position: [number, number, number], target: [number, number, number], fov?: number) {
    return () => {
        backdrop(viewer, bg)
        setCamera(viewer, position, target, fov)
    }
}

/** Per-view backdrop: the HDRI sky (eye-level views) or the studio sweep (diorama views). */
export function backdrop(viewer: ThreeViewer, kind: 'sky' | 'studio', intensity = 1) {
    const scene = viewer.scene as any
    if (kind === 'sky') scene.background = scene.environment?.userData?.__raw ?? 'environment'
    else scene.background = studioBackdrop()
    scene.backgroundIntensity = intensity
    viewer.setDirty()
}

/** Options of {@link litSky}. */
export interface SkyLight {
    /** Albedo of the ground painted below the horizon, lit by the sky's mean radiance (0 keeps the HDRI's own). */
    ground: number
    /** Ground color multiplier (warm earth by default). */
    tint: [number, number, number]
    /** Saturation of the sky light, 1 = as photographed. */
    saturation: number
}
const SKY_LIGHT: SkyLight = {ground: 0.25, tint: [1, 0.92, 0.8], saturation: 0.55}
/** Brightest pixel of the lighting copy, in mean sky luminances (clamps the painted sun; see {@link litSky}). */
const sunCap = 8
let skyLight: SkyLight = SKY_LIGHT

const toHalf = (() => {
    const f = new Float32Array(1), u = new Uint32Array(f.buffer)
    return (v: number) => {
        f[0] = v
        const x = u[0], s = (x >> 16) & 0x8000, e = ((x >> 23) & 0xff) - 127 + 15
        return e <= 0 ? s : e >= 31 ? s | 0x7c00 : s | (e << 10) | ((x & 0x7fffff) >> 13)
    }
})()

/**
 * The lighting copy of an equirectangular HDRI. Poly Haven "puresky" images continue the sky below the horizon, so a
 * downward face (an arcade vault, the underside of a balcony) is lit blue from below, where a real one sees the warm
 * ground; and a clear sky's deep blue tints every shadow, which a photographer's white balance would not keep. This
 * paints a ground of the given albedo below the horizon and trims the saturation. Cached per source and options.
 */
export function litSky(raw: any, o: SkyLight = skyLight) {
    const img = raw?.image, data = img?.data, w = img?.width, h = img?.height
    if (!data || !w || !h) return null
    const key = JSON.stringify(o)
    raw.userData.__lit ??= {}
    if (raw.userData.__lit[key]) return raw.userData.__lit[key]
    const st = data.length / (w * h)
    const isHalf = data instanceof Uint16Array
    const rd = isHalf ? half : (x: number) => x, wr = isHalf ? toHalf : (x: number) => x
    const out = data.slice()
    // sky radiance: mean over the upper half, cosine weighted, the sun disk clamped (the sun is the rig's light)
    const sum = [0, 0, 0]
    let wsum = 0
    for (let y = 0; y < h; y++) {
        const el = (0.5 - (y + 0.5) / h) * Math.PI, wy = Math.max(0, Math.sin(el)) * Math.cos(el)
        for (let x = 0; x < w; x++) {
            const k = (y * w + x) * st
            const r = rd(data[k]), g = rd(data[k + 1]), b = rd(data[k + 2])
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
            const c = [l + (r - l) * o.saturation, l + (g - l) * o.saturation, l + (b - l) * o.saturation]
            for (let i = 0; i < 3; i++) out[k + i] = wr(c[i])
            if (wy > 0) {
                for (let i = 0; i < 3; i++) sum[i] += Math.min(c[i], 20) * wy
                wsum += wy
            }
        }
    }
    // The sun disk (and any other pixel far above the sky) is clamped in the lighting copy as well: the rig's
    // directional light is the sun, with shadows; the painted one lit every surface a second time, unshadowed, as a
    // bright environment term that no occlusion of the sky removes The backdrop keeps the original.
    const cap = sunCap * Math.max(1e-3, (0.2126 * sum[0] + 0.7152 * sum[1] + 0.0722 * sum[2]) / Math.max(wsum, 1e-6))
    for (let k = 0; k < w * h * st; k += st) {
        const r = rd(out[k]), g = rd(out[k + 1]), b = rd(out[k + 2])
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if (l <= cap) continue
        const f = cap / l
        out[k] = wr(r * f); out[k + 1] = wr(g * f); out[k + 2] = wr(b * f)
    }
    if (o.ground > 0) {
        const ground = sum.map((v, c) => v / wsum * o.ground * o.tint[c])
        const blend = Math.max(2, Math.round(h / 64)), y0 = Math.floor(h / 2) - blend
        for (let y = y0; y < h; y++) {
            const t = Math.min(1, (y - y0) / (2 * blend))
            for (let x = 0; x < w; x++) {
                const k = (y * w + x) * st
                for (let c = 0; c < 3; c++) out[k + c] = wr(rd(out[k + c]) * (1 - t) + ground[c] * t)
            }
        }
    }
    const lit = new raw.constructor(out, w, h, raw.format, raw.type, raw.mapping)
    for (const p of ['colorSpace', 'flipY', 'generateMipmaps', 'magFilter', 'minFilter', 'wrapS', 'wrapT', 'name']) lit[p] = raw[p]
    lit.needsUpdate = true
    lit.userData = {__raw: raw, __hdriSun: hdriSun(raw)}
    raw.userData.__lit[key] = lit
    return lit
}

/** Loads a Poly Haven HDRI, lights the scene with its {@link litSky} copy, and returns the original for the backdrop. */
export async function setSky(viewer: ThreeViewer, id: string, o?: Partial<SkyLight>) {
    if (o) skyLight = {...skyLight, ...o}
    await viewer.setEnvironmentMap(polyHavenHdri(id))
    const scene = viewer.scene
    const raw = scene.environment as any
    const lit = litSky(raw)
    if (!lit) return raw
    raw.userData.__skyRaw = true
    const dispose = scene.autoDisposeSceneMaps
    scene.autoDisposeSceneMaps = false // the original stays in use as the backdrop
    scene.environment = lit
    scene.autoDisposeSceneMaps = dispose
    return raw
}
