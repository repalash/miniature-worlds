import {
    Box3,
    CubeCamera,
    getUrlQueryParam,
    HalfFloatType,
    IMaterial,
    Mesh,
    Object3D,
    PhysicalMaterial,
    PMREMGenerator,
    ShaderChunk,
    ThreeViewer,
    TonemapPlugin,
    Vector3,
    WebGLCubeRenderTarget,
    WebGLRenderTarget,
} from 'threepipe'
import {SSGIPlugin} from '@threepipe/webgi-plugins'

/**
 * Light probes captured from the scene at runtime: a cube camera renders the scene from a point in a room (without
 * the screen-space passes, and without redrawing the shadow maps), the capture is prefiltered (PMREM) and becomes
 * the environment map of the materials in that room, in place of the sky.
 *
 * Inside a room the sky HDRI lights every surface as if it stood in the open, ceiling or not: walls under a roof get
 * the full sky fill and its reflections, and the room comes out too bright and too blue. A probe sees the ceiling,
 * the walls and the floor, and the sky only through the windows, so the ambient light and the reflections have the
 * room's level and colour. It also carries the room's first bounce from everything the camera does not see, which
 * SSGI cannot. One probe is exact only at its centre; with a `box` (the room's walls) the lookups are box-projected
 * (parallax-corrected), so reflections on a floor or a table stay in place as the camera moves and the light near a
 * wall comes from that wall. Use one probe per room.
 *
 * The capture runs twice on the first update, so the room is lit once by its own probe (a second bounce). Call
 * `update()` after the light changes (time of day); it is a few milliseconds.
 */
export interface ProbeOptions {
    /** capture point (world) */
    position: [number, number, number]
    /** the room's walls (world box): box projection, and the default set of meshes (centre inside the box) */
    box?: [[number, number, number], [number, number, number]]
    /** meshes that take this probe (default: meshes whose bounding-box centre is inside `box`) */
    include?: (mesh: Mesh) => boolean
    /** objects hidden while capturing (e.g. a car standing at the probe) */
    hide?: Object3D[]
    /** cube face size (px) */
    size?: number
    /** scale of the probe's light on the materials (1 = physical) */
    intensity?: number
    /** captures on the first update (2 = the room lit once by its own probe) */
    bounces?: number
}

const PROBE_KEY = '__probe'

export function envProbe(viewer: ThreeViewer, o: ProbeOptions) {
    const token = {} // marks the materials this probe owns
    const size = o.size ?? 256
    const rt = new WebGLCubeRenderTarget(size, {type: HalfFloatType})
    const cam = new CubeCamera(0.05, 2000, rt)
    cam.position.set(...o.position)
    const box = o.box ? new Box3(new Vector3(...o.box[0]), new Vector3(...o.box[1])) : undefined
    let pmrem: PMREMGenerator | undefined, target: WebGLRenderTarget | undefined

    // The materials of the meshes in the room. A material that a mesh outside the room also uses (another probe's
    // room, or the open courtyard) is cloned for the room: otherwise the outside mesh takes this probe's cube map,
    // box-projected from far outside its box, where the projected direction jumps with the sign of the normal (a
    // bumped wall in the open then shows hard light and dark blotches).
    const materials = new Set<PhysicalMaterial>()
    const include = o.include ?? ((m: Mesh) => {
        if (!box) return true
        const b = new Box3().setFromObject(m)
        return box.containsPoint(b.getCenter(new Vector3()))
    })
    const inRoom: Mesh[] = [], outside = new Set<any>()
    viewer.scene.modelRoot.traverse((obj: any) => {
        if (!obj.isMesh || !obj.material) return
        if (!o.hide?.some(h => isInside(obj, h)) && include(obj)) inRoom.push(obj)
        else outside.add(obj.material)
    })
    const clones = new Map<PhysicalMaterial, PhysicalMaterial>()
    for (const obj of inRoom) {
        const m = obj.material as PhysicalMaterial
        if (!(m as any).isMeshStandardMaterial) continue
        const owner = m.userData[PROBE_KEY]
        if ((owner && owner !== token) || outside.has(m)) {
            let c = clones.get(m)
            if (!c) {
                c = m.clone() as PhysicalMaterial
                // extensions (procedural shaders) are not part of a material's values: carry them over
                const ext = (m as any).materialExtensions
                if (ext?.length) (c as any).registerMaterialExtensions?.(ext)
                c.userData[PROBE_KEY] = token
                clones.set(m, c)
            }
            obj.material = c
            materials.add(c)
        } else {
            m.userData[PROBE_KEY] = token
            materials.add(m)
        }
    }

    const intensity = o.intensity ?? 1
    const ext = box ? boxProjection(box, cam.position) : undefined
    const apply = () => {
        for (const m of materials) {
            if (m.envMap === target!.texture) continue
            m.envMap = target!.texture as any
            m.envMapIntensity = intensity
            if (ext && !(m as any).materialExtensions?.includes(ext)) (m as any).registerMaterialExtensions?.([ext])
            m.setDirty?.()
        }
    }

    const capture = () => {
        const r = viewer.renderManager.renderer as any
        const vis = (o.hide ?? []).map(h => h.visible)
        o.hide?.forEach(h => h.visible = false)
        const shadows = r.shadowMap.needsUpdate
        r.shadowMap.needsUpdate = false
        const render = () => cam.update(r, viewer.scene as any)
        if (r.renderWithModes) r.renderWithModes({screenSpaceRendering: false, mainRenderPass: false}, render)
        else render()
        r.shadowMap.needsUpdate = shadows
        o.hide?.forEach((h, i) => h.visible = vis[i])
        target = (pmrem ??= new PMREMGenerator(r)).fromCubemap(rt.texture as any, target as any)
        apply()
    }

    let first = true
    const state = {needsUpdate: true}
    const update = () => {
        const n = first ? (o.bounces ?? 2) : 1
        first = false
        for (let i = 0; i < n; i++) capture()
        viewer.setDirty()
    }
    viewer.addEventListener('preFrame', () => {
        if (!state.needsUpdate) return
        state.needsUpdate = false
        update()
    })
    const probe = {update, state, materials, get texture() { return target?.texture }, cube: rt}
    return probe
}

function isInside(o: Object3D, root: Object3D) {
    for (let p: Object3D | null = o; p; p = p.parent) if (p === root) return true
    return false
}

/**
 * Box projection of the environment lookups (parallax-corrected cube maps, as in Lagarde & Zanuttini, "Local Image-
 * based Lighting With Parallax-corrected Cubemap", SIGGRAPH 2012): a lookup direction from a shaded point is
 * intersected with the room's box, and the probe is sampled toward that hit point, so the room's walls in the
 * probe line up with the real ones wherever the point is.
 */
function boxProjection(box: Box3, at: Vector3) {
    const pars = `
        uniform vec3 probeBoxMin;
        uniform vec3 probeBoxMax;
        uniform vec3 probePosition;
        varying vec3 vProbeWorldPosition;
        vec3 probeDirection(const in vec3 d) {
            vec3 p = vProbeWorldPosition;
            vec3 t = max((probeBoxMax - p) / d, (probeBoxMin - p) / d);
            float f = min(min(t.x, t.y), t.z);
            return f > 0.0 ? normalize(p + d * f - probePosition) : d;
        }
    `
    return {
        uuid: 'probe-box-' + box.min.toArray().join(',') + box.max.toArray().join(','),
        extraUniforms: {
            probeBoxMin: {value: box.min.clone()},
            probeBoxMax: {value: box.max.clone()},
            probePosition: {value: at.clone()},
        },
        parsVertexSnippet: 'varying vec3 vProbeWorldPosition;',
        shaderExtender: (shader: any) => {
            shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>',
                '#include <worldpos_vertex>\n#ifdef USE_ENVMAP\nvProbeWorldPosition = worldPosition.xyz;\n#endif')
            const chunk = ShaderChunk.envmap_physical_pars_fragment
                .replace('envMapRotation * worldNormal', 'envMapRotation * probeDirection(worldNormal)')
                .replace('envMapRotation * reflectVec', 'envMapRotation * probeDirection(reflectVec)')
            // the declarations go with the chunk: threepipe inserts pars snippets after it
            shader.fragmentShader = shader.fragmentShader.replace('#include <envmap_physical_pars_fragment>', pars + chunk)
        },
        computeCacheKey: () => 'probebox2',
        isCompatible: (m: IMaterial) => (m as any).isMeshStandardMaterial,
    } as any
}

/**
 * One probe per room, unless the page has `?probe=0` (to compare with the sky fill). Returns a function that
 * recaptures them, and wraps a scene's times of day so each change of light recaptures.
 */
export function roomProbes(viewer: ThreeViewer, rooms: ProbeOptions[], o: {exposure?: number, ssgi?: number} = {}) {
    const on = getUrlQueryParam('probe') !== '0'
    const probes = on ? rooms.map(r => envProbe(viewer, r)) : []
    const recapture = () => probes.forEach(p => p.state.needsUpdate = true)
    // The scenes' exposures were raised to make up for the bounce light the sky fill did not give a room; the probe
    // gives it (and SSGI adds the near-field part of the same light), so both come down when the probes are on.
    const exposure = on ? o.exposure ?? 0.75 : 1
    const tonemap = viewer.getPlugin(TonemapPlugin)
    const scaleExposure = () => { if (tonemap && exposure !== 1) { tonemap.exposure *= exposure; tonemap.setDirty() } }
    scaleExposure()
    const ssgi = viewer.getPlugin(SSGIPlugin) as any
    if (on && ssgi?.pass) ssgi.pass.intensity *= o.ssgi ?? 0.6
    const wrapTimes = <T extends Record<string, () => any>>(times: T): T => {
        for (const k of Object.keys(times) as (keyof T)[]) {
            const f = times[k]
            times[k] = (async() => { await f(); scaleExposure(); recapture() }) as any
        }
        return times
    }
    return {probes, recapture, wrapTimes}
}
