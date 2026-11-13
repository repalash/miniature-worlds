import {BufferGeometry, Color, PhysicalMaterial, ShaderChunk, SpotLight2, SRGBColorSpace, Texture, ThreeViewer, Vector3} from 'threepipe'

/**
 * Marks area-light samples (decay {@link AREA_SAMPLE_DECAY}) as diffuse only, in every material: their
 * glossy reflection is the lit screen itself, seen by screen-space reflections on the floor and by the cube map on
 * the car. A point light's own highlight would count that reflection twice and, from a few dozen sample points,
 * show as a row of separate blobs on a glossy floor.
 */
export const AREA_SAMPLE_DECAY = 2.001
let diffuseOnlyPatched = false
export function patchDiffuseOnlySpots() {
    if (diffuseOnlyPatched) return
    diffuseOnlyPatched = true
    const chunk = ShaderChunk.lights_fragment_begin
    const loop = chunk.indexOf('NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )')
    const call = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );'
    const at = chunk.indexOf(call, loop)
    if (loop < 0 || at < 0) { console.warn('vehicle stage: lights_fragment_begin changed, spot patch not applied'); return }
    // in braces: three unrolls this loop without them, and each light would declare the same names again
    ShaderChunk.lights_fragment_begin = chunk.slice(0, at) + `{
        vec3 areaKeepSpec = reflectedLight.directSpecular;
        #ifdef USE_CLEARCOAT
        vec3 areaKeepCc = clearcoatSpecularDirect;
        #endif
        #ifdef USE_SHEEN
        vec3 areaKeepSh = sheenSpecularDirect;
        #endif
        ${call}
        if ( spotLight.decay > ${(AREA_SAMPLE_DECAY - 0.0005).toFixed(4)} ) {
            reflectedLight.directSpecular = areaKeepSpec;
            #ifdef USE_CLEARCOAT
            clearcoatSpecularDirect = areaKeepCc;
            #endif
            #ifdef USE_SHEEN
            sheenSpecularDirect = areaKeepSh;
            #endif
        }
        }` + chunk.slice(at + call.length)
}


/**
 * Real light from emissive surfaces (screens, light panels): the largest, brightest flat patches of the meshes that
 * use `materials` become area lights. Each is a shadow-casting spot that moves to a new point of its patch every
 * progressive frame (area-weighted triangles), facing out of it, in the patch's mean colour (read from the
 * emissive map), diffuse only (see {@link patchDiffuseOnlySpots}): accumulated over the frames it is the patch's
 * soft area light. SSGI sees an emitter only while it is on screen and near; these light the street and the facades
 * from screens that are behind the camera, far away or out of frame.
 */
export interface EmissiveLightsOptions {
    /** number of lights (the strongest patches) */
    count?: number
    /** patches smaller than this (m^2) are left out */
    minArea?: number
    /** intensity scale (candela per unit of emitted radiance and m^2) */
    gain?: number
    /** shadow map size */
    shadowMapSize?: number
    /**
     * how many of the lights (the strongest) cast shadows: each shadow map is one more texture unit in every lit
     * material, and a material with its own maps, the G-buffer and SSGI/SSR inputs runs out of the 16 units with
     * more than a few (the shader then fails to compile and the mesh disappears)
     */
    shadows?: number
    /** spatial cell (m) that splits large coplanar regions into separate patches */
    cell?: number
}

interface Patch {area: number, color: Color, normal: Vector3, centre: Vector3, tris: Vector3[][], cum: number[]}

export function emissiveLights(viewer: ThreeViewer, materials: Iterable<PhysicalMaterial>, o: EmissiveLightsOptions = {}) {
    patchDiffuseOnlySpots()
    const mats = new Set(materials)
    const cell = o.cell ?? 30
    const patches = new Map<string, Patch>()
    const sampler = new Map<Texture, (u: number, v: number) => Color>()
    const colorAt = (t: Texture | null, u: number, v: number) => {
        if (!t?.image) return new Color(1, 1, 1)
        let f = sampler.get(t)
        if (!f) {
            const n = 256, c = document.createElement('canvas')
            c.width = c.height = n
            const x = c.getContext('2d', {willReadFrequently: true})!
            x.drawImage(t.image as any, 0, 0, n, n)
            const d = x.getImageData(0, 0, n, n).data
            f = (uu: number, vv: number) => {
                uu -= Math.floor(uu); vv -= Math.floor(vv)
                const px = Math.min(n - 1, Math.floor(uu * n)), py = Math.min(n - 1, Math.floor((t.flipY ? 1 - vv : vv) * n))
                const k = (py * n + px) * 4
                return new Color().setRGB(d[k] / 255, d[k + 1] / 255, d[k + 2] / 255, SRGBColorSpace)
            }
            sampler.set(t, f)
        }
        return f(u, v)
    }
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), e1 = new Vector3(), e2 = new Vector3()
    viewer.scene.modelRoot.updateMatrixWorld(true)
    viewer.scene.modelRoot.traverse((obj: any) => {
        if (!obj.isMesh || !mats.has(obj.material) || obj.isInstancedMesh) return
        const m = obj.material as PhysicalMaterial, g = obj.geometry as BufferGeometry
        const pos = g.attributes.position, uv = g.attributes.uv, idx = g.index
        const count = (idx ? idx.count : pos.count) / 3
        const vi = (t: number, k: number) => idx ? idx.getX(t * 3 + k) : t * 3 + k
        for (let t = 0; t < count; t++) {
            a.fromBufferAttribute(pos, vi(t, 0)).applyMatrix4(obj.matrixWorld)
            b.fromBufferAttribute(pos, vi(t, 1)).applyMatrix4(obj.matrixWorld)
            c.fromBufferAttribute(pos, vi(t, 2)).applyMatrix4(obj.matrixWorld)
            const n = e1.subVectors(b, a).cross(e2.subVectors(c, a))
            const area = n.length() / 2
            if (area < 1e-4) continue
            n.normalize()
            const centre = a.clone().add(b).add(c).multiplyScalar(1 / 3)
            // a patch: same facing (15 deg bins), same plane (1 m), same cell along it
            const key = [n.x, n.y, n.z].map(v => Math.round(v * 4)).join(',') + '|' + Math.round(n.dot(centre)) + '|' +
                [centre.x, centre.y, centre.z].map(v => Math.floor(v / cell)).join(',')
            let col = new Color(1, 1, 1)
            if (uv) {
                const u0 = (uv.getX(vi(t, 0)) + uv.getX(vi(t, 1)) + uv.getX(vi(t, 2))) / 3
                const v0 = (uv.getY(vi(t, 0)) + uv.getY(vi(t, 1)) + uv.getY(vi(t, 2))) / 3
                col = colorAt(m.emissiveMap, u0, v0)
            }
            col.multiply(m.emissive)
            let p = patches.get(key)
            if (!p) patches.set(key, p = {area: 0, color: new Color(0, 0, 0), normal: new Vector3(), centre: new Vector3(), tris: [], cum: []})
            p.area += area
            p.color.add(col.multiplyScalar(area))
            p.normal.addScaledVector(n, area)
            p.centre.addScaledVector(centre, area)
            p.tris.push([a.clone(), b.clone(), c.clone()])
            p.cum.push(p.area)
        }
    })
    const lum = (k: Color) => 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b
    const chosen = [...patches.values()].filter(p => p.area >= (o.minArea ?? 40)).map(p => {
        p.color.multiplyScalar(1 / p.area)
        p.normal.normalize()
        p.centre.multiplyScalar(1 / p.area)
        return p
    }).sort((x, y) => y.area * lum(y.color) - x.area * lum(x.color)).slice(0, o.count ?? 8)

    let gain = o.gain ?? 1, glow = 1
    const lights = chosen.map((p, i) => {
        const l = new SpotLight2(0xffffff, 0, 0, 1.5, 1, AREA_SAMPLE_DECAY)
        l.name = 'Screen light ' + i
        const peak = Math.max(p.color.r, p.color.g, p.color.b, 1e-4)
        l.color.copy(p.color).multiplyScalar(1 / peak)
        ;(l as any).userData.flux = peak * p.area
        if (i < (o.shadows ?? 3)) {
            l.castShadow = true
            l.shadow.mapSize.set(o.shadowMapSize ?? 1024, o.shadowMapSize ?? 1024)
            l.shadow.bias = -0.0003
            l.shadow.normalBias = 0.05
            l.shadow.camera.near = 0.5
            l.shadow.camera.far = 400
            l.shadow.focus = 0.6
        }
        l.position.copy(p.centre).addScaledVector(p.normal, 0.2)
        l.target.position.copy(l.position).addScaledVector(p.normal, 10)
        viewer.scene.addObject(l as any)
        viewer.scene.addObject(l.target as any)
        return l
    })
    const apply = () => {
        lights.forEach(l => { l.intensity = gain * glow * (l as any).userData.flux; l.visible = l.intensity > 0 })
        viewer.renderManager.resetShadows()
        viewer.setDirty()
    }
    apply()
    const halton = (i: number, base: number) => { let f = 1, r = 0; while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base) } return r }
    let last = -1
    viewer.addEventListener('preFrame', () => {
        const f = viewer.renderManager.frameCount
        if (f === last || !lights.length) return
        last = f
        lights.forEach((l, i) => {
            const p = chosen[i]
            if (!l.visible) return
            if (f === 0) l.position.copy(p.centre)
            else {
                const x = halton(f + 7 * i, 2) * p.area
                let lo = 0, hi = p.cum.length - 1
                while (lo < hi) { const m = (lo + hi) >> 1; if (p.cum[m] < x) lo = m + 1; else hi = m }
                const [ta, tb, tc] = p.tris[lo]
                let u = halton(f + 7 * i, 3), v = halton(f + 7 * i, 5)
                if (u + v > 1) { u = 1 - u; v = 1 - v }
                l.position.copy(ta).addScaledVector(e1.subVectors(tb, ta), u).addScaledVector(e2.subVectors(tc, ta), v)
            }
            l.position.addScaledVector(p.normal, 0.2)
            l.target.position.copy(l.position).addScaledVector(p.normal, 10)
            l.updateMatrixWorld()
            l.target.updateMatrixWorld()
        })
        viewer.renderManager.resetShadows()
    })
    return {
        lights, patches: chosen,
        /** scale with the screens' emissive intensity */
        setGlow(k: number) { glow = k; apply() },
        setGain(k: number) { gain = k; apply() },
    }
}
