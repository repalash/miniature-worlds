import {BufferAttribute, BufferGeometry, Color, Mesh, PhysicalMaterial, ShaderChunk, ThreeViewer} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {waterMaterial} from './sea'
import {NOISE} from './proc'
import {smoothstep} from './noise'
import type {GroundPath} from './path'

/**
 * Inland water for the tiles: a still pond or tarn (the pool water of sea.ts with a calm surface, its depth and a
 * shore foam weight from the terrain), and a mountain creek as a ribbon along a path that flows: ripples and foam
 * streaks move downstream, white water where the bed steps down and round rocks, glassy runs between.
 */

export interface PondOptions {
    /** Ground under the water. */
    height: (x: number, z: number) => number
    level: number
    /** Area to cover, [x0, z0, x1, z1], and grid resolution (cells per metre). */
    area: [number, number, number, number]
    density?: number
    attenuation?: Color
    attenuationDistance?: number
    /** Ripple amplitude (0.03 still, 0.15 breezy). */
    amp?: number
    /** Water colour where shallow and where deep (linear, vertex colours). */
    shallow?: [number, number, number]
    deep?: [number, number, number]
    /** 0 (default) opaque, coloured by depth; up to 1 refracts the bed (costs a transmission pass). */
    transmission?: number
    /** Keep only the water connected to this point (x, z): a lake, not every hollow below its level. */
    seed?: [number, number]
    /** Where the water may spread (e.g. not down an outlet gorge). */
    within?: (x: number, z: number) => boolean
}

export function buildPond(viewer: ThreeViewer, o: PondOptions) {
    const [x0, z0, x1, z1] = o.area
    const k = o.density ?? 3
    const nx = Math.ceil((x1 - x0) * k), nz = Math.ceil((z1 - z0) * k)
    const pos: number[] = [], col: number[] = [], data: number[] = [], idx: number[] = []
    const depth: number[] = []
    const sh = o.shallow ?? [0.05, 0.12, 0.1], dp = o.deep ?? [0.01, 0.035, 0.05]
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + (x1 - x0) * i / nx, z = z0 + (z1 - z0) * j / nz
        const d = o.level - o.height(x, z)
        depth.push(d)
        pos.push(x, o.level, z)
        const t = smoothstep(0.1, 2.5, d)
        col.push(sh[0] + (dp[0] - sh[0]) * t, sh[1] + (dp[1] - sh[1]) * t, sh[2] + (dp[2] - sh[2]) * t)
        data.push(Math.max(0.02, d), 0.4)
    }
    const n1 = nx + 1
    // flood fill from the seed over the wet vertices (a vertex just above the level still closes the shore)
    let keep: Uint8Array | undefined
    if (o.seed) {
        keep = new Uint8Array(depth.length)
        const si = Math.round((o.seed[0] - x0) / (x1 - x0) * nx), sj = Math.round((o.seed[1] - z0) / (z1 - z0) * nz)
        const stack = [sj * n1 + si]
        while (stack.length) {
            const k = stack.pop()!
            if (keep[k]) continue
            keep[k] = 1
            if (depth[k] < 0) continue
            const i = k % n1, j = Math.floor(k / n1)
            if (o.within && !o.within(x0 + (x1 - x0) * i / nx, z0 + (z1 - z0) * j / nz)) continue
            if (i > 0) stack.push(k - 1)
            if (i < nx) stack.push(k + 1)
            if (j > 0) stack.push(k - n1)
            if (j < nz) stack.push(k + n1)
        }
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1
        if (Math.max(depth[a], depth[b], depth[c], depth[d]) < -0.05) continue
        if (keep && !(keep[a] && keep[b] && keep[c] && keep[d])) continue
        idx.push(a, c, b, b, c, d)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(pos.length).map((_, i) => i % 3 === 1 ? 1 : 0), 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
    g.setAttribute('waterData', new BufferAttribute(new Float32Array(data), 2))
    g.setIndex(idx)
    g.computeBoundingSphere()
    // opaque by default: a transmissive surface costs a second render of the whole scene (the transmission pass)
    const w = waterMaterial({amp: o.amp ?? 0.05, scale: 0.12, attenuation: o.attenuation ?? new Color(0.25, 0.55, 0.6), attenuationDistance: o.attenuationDistance ?? 2.5, opaque: 0, transmission: o.transmission ?? 0})
    w.material.vertexColors = true
    w.material.name = 'Pond water'
    const mesh = new Mesh(g, w.material)
    mesh.name = 'Pond'
    viewer.scene.addObject(mesh)
    mesh.castShadow = false
    mesh.receiveShadow = true
    return {mesh, uniforms: w.uniforms, material: w.material}
}

const CREEK_VERT = /* glsl */`
attribute vec4 creek;
varying vec4 vCreek;
varying vec3 vCreekPos;
`
const CREEK_FRAG = /* glsl */`
uniform float waterTime;
uniform float crFoamK;
uniform float crRippleK;
varying vec4 vCreek;
varying vec3 vCreekPos;
${NOISE}
float crFoam;
vec3 crNormal;
`

export interface CreekOptions {
    /** Water surface height at a distance along the path and across it (signed, m). */
    surface: (s: number, across: number, x: number, z: number) => number
    /** Half width along the path. */
    halfWidth: (s: number) => number
    /** White water 0..1 along the path (falls, rapids). */
    white?: (s: number) => number
    /** Depth for the absorption. */
    depth?: number
    /** 0 (default) opaque; up to 1 refracts the bed (costs a transmission pass). */
    transmission?: number
    /** Strength of the sky's reflection (default 0.3). */
    envReflection?: number
    step?: number
    across?: number
    /** Part of the path to cover, [s0, s1] (default all of it). */
    range?: [number, number]
    /** Scale of the foam streaks on the runs (default 1; lower for a slow, glassy stream). */
    foam?: number
    /** Scale of the ripples (default 1). */
    ripple?: number
    /** Water colour (default a dark green-grey). */
    color?: [number, number, number]
    /** Below 1, the water is alpha-blended over its bed (a shallow, clear stream; no transmission pass). */
    opacity?: number
}

/** A creek ribbon along a path, with flowing ripples and foam. */
export function buildCreek(viewer: ThreeViewer, path: GroundPath, o: CreekOptions) {
    const step = o.step ?? 0.25, nA = o.across ?? 8
    const pos: number[] = [], data: number[] = [], idx: number[] = []
    const [s0, s1] = o.range ?? [0, path.length]
    const rows = Math.ceil((s1 - s0) / step)
    for (let r = 0; r <= rows; r++) {
        const s = Math.min(s1, s0 + r * step)
        const {p, dir} = path.at(s)
        const hw = o.halfWidth(s)
        const white = o.white?.(s) ?? 0
        for (let a = 0; a <= nA; a++) {
            const t = a / nA * 2 - 1
            const across = t * hw
            const x = p.x - dir.z * across, z = p.z + dir.x * across
            pos.push(x, o.surface(s, across, x, z), z)
            data.push(s, t, white, 1 - Math.abs(t))
        }
    }
    const n1 = nA + 1
    for (let r = 0; r < rows; r++) for (let a = 0; a < nA; a++) {
        const i = r * n1 + a, b = i + 1, c = i + n1, d = c + 1
        idx.push(i, c, b, b, c, d)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('creek', new BufferAttribute(new Float32Array(data), 4))
    g.setIndex(idx)
    g.computeVertexNormals()
    // make the ribbon face up
    const ny = (g.attributes.normal as BufferAttribute).getY(Math.floor(pos.length / 6))
    if (ny < 0) {
        for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t }
        g.setIndex(idx)
        g.computeVertexNormals()
    }
    g.computeBoundingSphere()
    const m = new PhysicalMaterial({color: new Color(...(o.color ?? [0.035, 0.06, 0.06])), roughness: 0.04, metalness: 0})
    m.name = 'Creek water'
    m.transmission = o.transmission ?? 0
    m.ior = 1.333
    m.thickness = o.depth ?? 0.3
    m.attenuationColor = new Color(0.45, 0.68, 0.62)
    m.attenuationDistance = 0.8
    if (o.opacity !== undefined && o.opacity < 1) {
        m.transparent = true
        m.opacity = o.opacity
        m.depthWrite = true
    }
    m.userData.renderToGBuffer = true
    // a creek runs between banks and walls: the sky's reflection (the environment map, which knows no walls) is
    // kept low, SSR shows what is really there
    m.userData.separateEnvMapIntensity = true
    m.envMapIntensity = o.envReflection ?? 0.3
    const uniforms = {waterTime: {value: 0}, crFoamK: {value: o.foam ?? 1}, crRippleK: {value: o.ripple ?? 1}}
    const ext: MaterialExtension = {
        extraUniforms: uniforms as any,
        parsVertexSnippet: CREEK_VERT,
        parsFragmentSnippet: CREEK_FRAG,
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    vCreek = creek;
    vCreekPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    {
        float s = vCreek.x, t = vCreek.y;
        float flow = s - waterTime * 1.6;
        // streaks along the current, broken up
        float streak = n_snoise(vec2(flow * 1.2, t * 6.0)) * 0.6 + n_snoise(vec2(flow * 3.5, t * 14.0)) * 0.4;
        float churn = n_snoise(vec2(flow * 6.0, t * 9.0 + waterTime));
        float edge = 1.0 - smoothstep(0.0, 0.35, vCreek.w);
        float white = clamp(vCreek.z + 0.35 * edge, 0.0, 1.0);
        // runs: sparse foam streaks; falls and rapids: white water torn into streaks with dark water between
        float runs = smoothstep(0.55, 0.85, streak * 0.5 + 0.5) * 0.6 * (1.0 - white) * crFoamK;
        float falls = smoothstep(0.3, 0.75, n_snoise(vec2(flow * 0.7, t * 7.0)) * 0.5 + 0.5 + 0.15 * churn + 0.35 * white - 0.2) * white;
        crFoam = clamp(max(runs, falls) + 0.4 * edge * white * crFoamK, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.78, 0.78), crFoam);
        // ripples: moving downstream, steeper in the white water
        float e = 0.05;
        float h0 = n_snoise(vec2(flow * 2.4, t * 5.0)) + 0.5 * n_snoise(vec2(flow * 6.0 + 3.0, t * 11.0));
        float hx = n_snoise(vec2((flow + e) * 2.4, t * 5.0)) + 0.5 * n_snoise(vec2((flow + e) * 6.0 + 3.0, t * 11.0));
        float ht = n_snoise(vec2(flow * 2.4, (t + e) * 5.0)) + 0.5 * n_snoise(vec2(flow * 6.0 + 3.0, (t + e) * 11.0));
        float amp = (0.02 + 0.08 * white) * crRippleK;
        crNormal = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(ht - h0) / e * amp));
    }
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_fragment>', ShaderChunk.transmission_fragment
                .replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - crFoam);'))
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor = mix(roughnessFactor, 0.6, crFoam);
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    {
        // the ripple normal is in the ribbon's frame: tilt the surface normal by it
        vec3 n = normalize(normal + (viewMatrix * vec4(crNormal.x, 0.0, crNormal.z, 0.0)).xyz);
        normal = n;
    }
`)
        },
        computeCacheKey: () => 'creek-1',
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    m.registerMaterialExtensions([ext])
    const mesh = new Mesh(g, m)
    mesh.name = 'Creek'
    viewer.scene.addObject(mesh)
    mesh.castShadow = false
    mesh.receiveShadow = true
    return {mesh, uniforms, material: m}
}
