import {BufferAttribute, BufferGeometry, Color, Mesh, PhysicalMaterial, ThreeViewer, Vector2, Vector3} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {smoothstep} from './noise'

/**
 * Water bodies for the tile worlds: a transmissive surface that refracts what lies under it (screen space, from the opaque frame, rejecting
 * samples of things above the water), absorbs along the path (Beer-Lambert) and scatters back the water's own
 * colour, with Fresnel reflection on top (SSR and the sky). Beyond a single sea plane:
 *
 * - The surface need not be one plane: `level(x, z)` gives the water level per place (paddies on terraces, pools
 *   along a stream bed, the steps of a falls). The level travels with each vertex, so the refraction test uses the
 *   level of the pixel's own surface. Triangles that span a change of level (a bund between two paddies) are dropped.
 * - The look is a preset: clear paddy water, murky bayou, a brown pool, white-water; ripple height and length, flow
 *   (a direction and speed the ripples and foam drift along), foam at the shore and along a flow mask.
 * - Waves are uniforms, so every body shares one shader program.
 *
 * Without the G-buffer unpack extension the refraction samples are not filtered (WATER_NO_GBUFFER).
 */

export interface WaterLook {
    /** Absorption colour (what is left after `distance` metres) and distance. */
    attenuation: [number, number, number]
    distance: number
    /** In-scatter albedo (linear): the colour the water column sends back. */
    scatter: [number, number, number]
    /** Surface colours by depth (linear): wet margin, shallow, mid, deep; depths where each takes over. */
    colors: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]]
    depths?: [number, number, number]
    roughness?: number
    /** Foam colour (linear). */
    foam?: [number, number, number]
}

export const WATER_LOOKS: Record<string, WaterLook> = {
    /** Clear, still paddy water over mud: mostly a mirror, the mud shows near the bunds. */
    paddy: {attenuation: [0.42, 0.5, 0.42], distance: 0.35, scatter: [0.01, 0.014, 0.008],
        colors: [[0.06, 0.06, 0.045], [0.045, 0.05, 0.04], [0.03, 0.04, 0.035], [0.02, 0.03, 0.03]], depths: [0.04, 0.2, 0.5], roughness: 0.02},
    /** Paddy water as an opaque mirror: the colour is the mud seen through a hand's depth of clear water. */
    paddyOpaque: {attenuation: [0.42, 0.5, 0.42], distance: 0.35, scatter: [0.01, 0.014, 0.008],
        colors: [[0.1, 0.09, 0.07], [0.085, 0.08, 0.066], [0.07, 0.07, 0.062], [0.055, 0.057, 0.054]], depths: [0.03, 0.12, 0.4], roughness: 0.015},
    /** Tannin-stained black water with duckweed green in the shallows. */
    bayou: {attenuation: [0.22, 0.16, 0.06], distance: 0.25, scatter: [0.006, 0.006, 0.002],
        colors: [[0.04, 0.035, 0.02], [0.025, 0.022, 0.012], [0.015, 0.014, 0.008], [0.008, 0.008, 0.005]], depths: [0.05, 0.3, 1.0], roughness: 0.03},
    /** Black water as an opaque mirror: tannin-brown at the margins, near black in depth. */
    bayouOpaque: {attenuation: [0.22, 0.16, 0.06], distance: 0.25, scatter: [0.006, 0.006, 0.002],
        colors: [[0.045, 0.036, 0.022], [0.026, 0.021, 0.013], [0.014, 0.012, 0.008], [0.008, 0.008, 0.006]], depths: [0.05, 0.3, 1.0], roughness: 0.02},
    /** A muddy savanna pool: brown-green, opaque within a few decimetres. */
    pool: {attenuation: [0.5, 0.38, 0.18], distance: 0.18, scatter: [0.03, 0.022, 0.01],
        colors: [[0.09, 0.06, 0.035], [0.07, 0.05, 0.03], [0.05, 0.04, 0.025], [0.035, 0.03, 0.02]], depths: [0.03, 0.12, 0.4], roughness: 0.03},
    /** The same pool as an opaque surface (`opaque: true`): the colour is the water's own. */
    poolOpaque: {attenuation: [0.5, 0.38, 0.18], distance: 0.18, scatter: [0.03, 0.022, 0.01],
        colors: [[0.13, 0.085, 0.05], [0.1, 0.075, 0.045], [0.075, 0.062, 0.04], [0.055, 0.048, 0.032]], depths: [0.04, 0.15, 0.4], roughness: 0.02},
    /** A clear mountain stream: green-blue in depth, the stones visible. */
    stream: {attenuation: [0.45, 0.78, 0.74], distance: 0.9, scatter: [0.006, 0.02, 0.022],
        colors: [[0.07, 0.08, 0.075], [0.05, 0.08, 0.08], [0.03, 0.07, 0.075], [0.02, 0.05, 0.06]], depths: [0.05, 0.4, 1.5], roughness: 0.03,
        foam: [0.62, 0.66, 0.66]},
}

export interface WaterBodyOptions {
    /** Square area (m), centred on the origin, and grid resolution. */
    size: number
    res: number
    /** Ground height; the depth is level - height. */
    height: (x: number, z: number) => number
    /** Water level at x, z (a constant for one plane). */
    level: number | ((x: number, z: number) => number)
    /** Where there is water (default: where the ground is under the level + 0.25 m). */
    include?: (x: number, z: number, depth: number) => boolean
    look?: WaterLook
    /** Ripples: height scale (1 = an open sea), wave length (m, longest), drift speed. */
    waves?: {amplitude?: number, length?: number, speed?: number}
    /** Flow direction on the surface (x, z), a speed (m/s, 0 = still). */
    flow?: (x: number, z: number) => [number, number, number]
    /** Foam 0..1 per place (white water). */
    foam?: (x: number, z: number, depth: number) => number
    /** Foam in a band at the shore (0..1). */
    shoreFoam?: number
    /** Floating cover (duckweed, scum) 0..1 per place, and its colour (linear). */
    cover?: (x: number, z: number, depth: number) => number
    coverColor?: [number, number, number]
    /** Close the cut-away edges of the tile with a water slab. */
    slab?: boolean
    /**
     * No transmission: the water is an opaque mirror over its depth colour. Murky water looks the same, and the
     * frame saves the transmission pass (three renders every opaque object a second time for it).
     */
    opaque?: boolean
    name?: string
    /** Bounds of the grid in x, z (defaults to the square). */
    area?: [number, number, number, number]
    /**
     * With `flow`, triangles spanning any change of level are kept (a sloping reach); this drops those spanning more
     * than `maxStep` metres, so a sloping reach and the steps of a falls (drawn apart) can share one body.
     */
    maxStep?: number
}

const VERT = /* glsl */`
attribute vec4 waterData;
attribute vec3 waterFlow;
varying vec4 vWaterData;
varying vec3 vWaterFlow;
varying vec3 vWaterPos;
`

const WAVES = /* glsl */`
uniform float waterTime;
uniform vec3 waterWaves; // amplitude, length, speed
// Slope of the ripples (dh/dx, dh/dz), drifting with the flow.
vec2 waterSlope(vec2 p, vec2 flow) {
    vec2 s = vec2(0.0);
    p -= flow * waterTime;
    for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float a = 0.6 + fi * 2.4 + 0.55 * sin(fi * 2.4 + 0.7);
        vec2 dir = vec2(cos(a), sin(a));
        float wl = waterWaves.y * pow(0.66, fi);
        float k = 6.2831 / wl;
        float amp = wl * 0.008 * waterWaves.x;
        float ph = k * dot(dir, p) + sqrt(9.81 * k) * waterTime * waterWaves.z + fi * 1.7;
        s += dir * (amp * k * cos(ph));
    }
    return s;
}
`

const FRAG = /* glsl */`
varying vec4 vWaterData;   // depth, foam, shore foam, cover
varying vec3 vWaterFlow;   // flow x, z, speed
varying vec3 vWaterPos;
uniform vec3 waterFoamColor;
uniform vec3 waterCoverColor;
float waterFoam;
float waterCover;
float waterDepth;
vec3 waterNormal;
vec2 waterHash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}
float waterNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = waterHash(i).x, b = waterHash(i + vec2(1.0, 0.0)).x, c = waterHash(i + vec2(0.0, 1.0)).x, d = waterHash(i + vec2(1.0)).x;
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float waterCells(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(float(x), float(y));
        vec2 o = 0.5 + 0.4 * sin(waterTime * 0.5 + 6.2831 * waterHash(i + g));
        float d = length(g + o - f);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
    }
    return 1.0 - smoothstep(0.01, 0.09, d2 - d1);
}
`

const REFRACT = /* glsl */`
uniform vec2 waterNearFar;
uniform vec3 waterScatter;
vec2 waterToUv(const in vec3 p) {
    vec4 c = projectionMatrix * viewMatrix * vec4(p, 1.0);
    return c.xy / c.w * 0.5 + 0.5;
}
// 1 when the opaque frame at uv shows something under the water plane at height level
float waterUnder(const in vec2 uv, const in float level) {
#ifdef WATER_NO_GBUFFER
    return 1.0;
#endif
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 0.0;
    float lz = getDepth(uv);
    if (lz > 0.9999) return 0.0;
    float vd = waterNearFar.x + lz * (waterNearFar.y - waterNearFar.x);
    vec2 ndc = uv * 2.0 - 1.0;
    vec3 dv = vec3((ndc.x + projectionMatrix[2][0]) / projectionMatrix[0][0], (ndc.y + projectionMatrix[2][1]) / projectionMatrix[1][1], -1.0);
    vec3 dw = (vec4(dv, 0.0) * viewMatrix).xyz;
    if (dw.y > -1e-5) return 0.0;
    float tPlane = (level - cameraPosition.y) / dw.y;
    return step(tPlane * 0.996 - 0.03, vd);
}
vec4 waterRefraction(const in vec3 n, const in vec3 v, const in float roughness, const in vec3 diffuseColor,
        const in vec3 specularColor, const in float specularF90, const in vec3 position, const in float ior,
        const in float depth, const in vec3 attenuationColor, const in float attenuationDistance, const in vec3 light) {
    vec3 r = refract(-v, normalize(n), 1.0 / ior);
    float len = depth / max(-r.y, 0.3);
    vec2 uv0 = waterToUv(position);
    vec2 uv1 = waterToUv(position + r * len);
    vec2 uv = uv0;
    for (int i = 0; i < 4; i++) {
        vec2 c = mix(uv1, uv0, float(i) * 0.25);
        if (waterUnder(c, position.y) > 0.5) { uv = c; break; }
    }
    vec4 bed = getTransmissionSample(uv, roughness, ior);
    vec3 tv = volumeAttenuation(len, attenuationColor, attenuationDistance);
    vec3 transmittance = diffuseColor * tv;
    vec3 inscatter = waterScatter * light * (1.0 - tv);
    vec3 F = EnvironmentBRDF(n, v, specularColor, specularF90, roughness);
    float transmittanceFactor = (transmittance.r + transmittance.g + transmittance.b) / 3.0;
    return vec4((1.0 - F) * (transmittance * bed.rgb + inscatter), 1.0 - (1.0 - bed.a) * transmittanceFactor);
}
`

const TRANSMISSION = /* glsl */`
#ifdef USE_TRANSMISSION
    material.transmission = transmission * (1.0 - waterFoam);
    material.transmissionAlpha = 1.0;
    material.thickness = thickness * waterDepth;
    material.attenuationDistance = attenuationDistance;
    material.attenuationColor = attenuationColor;
    {
        vec3 wv = normalize(cameraPosition - vWorldPosition);
        vec3 wn = inverseTransformDirection(normal, viewMatrix);
        vec4 transmitted = waterRefraction(wn, wv, roughnessFactor, material.diffuseColor, material.specularColor,
            material.specularF90, vWorldPosition, material.ior, material.thickness, material.attenuationColor,
            material.attenuationDistance, totalDiffuse);
        material.transmissionAlpha = mix(material.transmissionAlpha, transmitted.a, material.transmission);
        totalDiffuse = mix(totalDiffuse, transmitted.rgb, material.transmission);
    }
#endif
`

export function waterBodyUniforms() {
    return {
        waterTime: {value: 0},
        waterWaves: {value: new Vector3(0.3, 1.2, 0.6)},
        waterNearFar: {value: new Vector2(0.1, 1000)},
        waterScatter: {value: new Color(0.01, 0.01, 0.01)},
        waterFoamColor: {value: new Color(0.6, 0.62, 0.62)},
        waterCoverColor: {value: new Color(0.05, 0.11, 0.02)},
    }
}
export type WaterBodyUniforms = ReturnType<typeof waterBodyUniforms>

export function waterBodyMaterial(viewer: ThreeViewer, look: WaterLook, uniforms: WaterBodyUniforms = waterBodyUniforms(), opaque = false) {
    const m = new PhysicalMaterial({color: '#ffffff', roughness: look.roughness ?? 0.03, metalness: 0})
    m.name = 'Water body'
    m.vertexColors = true
    m.transmission = opaque ? 0 : 1
    m.ior = 1.333
    m.thickness = 1
    m.attenuationColor = new Color(...look.attenuation)
    m.attenuationDistance = look.distance
    m.userData.renderToGBuffer = true
    uniforms.waterScatter.value.setRGB(...look.scatter)
    if (look.foam) uniforms.waterFoamColor.value.setRGB(...look.foam)
    const unpack = (viewer.renderManager as any).gbufferUnpackExtension as MaterialExtension | undefined
    const ext: MaterialExtension = {
        extraUniforms: uniforms as any,
        parsVertexSnippet: VERT,
        parsFragmentSnippet: WAVES + FRAG,
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    vWaterData = waterData;
    vWaterFlow = waterFlow;
    vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    {
        float depth = vWaterData.x;
        vec2 p = vWaterPos.xz;
        vec2 flow = vWaterFlow.xy * vWaterFlow.z;
        vec2 q = p - flow * waterTime;
        vec2 warp = vec2(waterNoise(q * 1.7), waterNoise(q * 1.7 + 7.3)) - 0.5;
        vec2 qq = q + warp * 0.9;
        float lace = max(waterCells(qq * 3.4), 0.8 * waterCells(qq * 7.9));
        lace *= smoothstep(0.25, 0.65, waterNoise(q * 11.0));
        float patches = smoothstep(0.25, 0.75, waterNoise(q * 0.7) * 0.7 + waterNoise(q * 2.1) * 0.3);
        // shore band
        float swash = (1.0 - smoothstep(0.0, 0.05, depth + 0.012 * sin(p.x * 1.3 + p.y * 0.7 + waterTime * 0.8))) * vWaterData.z;
        // white water: dense where the flow foams, streaky along the flow
        float white = vWaterData.y;
        float streak = waterNoise(vec2(dot(q, vec2(-vWaterFlow.y, vWaterFlow.x)) * 6.0, dot(q, vWaterFlow.xy) * 0.8));
        float wf = white * (0.55 + 0.45 * streak) * (0.6 + 0.4 * lace) + white * white * 0.5;
        waterFoam = clamp(max(swash * lace * (0.55 + 0.45 * patches), wf), 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, waterFoamColor, waterFoam);
        // floating cover: duckweed as a speckle of tiny fronds, dense in the middle of a patch, broken at its edge
        {
            float cm = vWaterData.w;
            float fronds = waterCells(p * 22.0 + 3.1) * 0.6 + waterNoise(p * 9.0) * 0.6;
            float patchE = waterNoise(p * 1.3 + 5.0) * 0.5 + waterNoise(p * 4.1) * 0.5;
            waterCover = cm > 0.0 ? smoothstep(0.35, 0.65, cm * 1.2 + (patchE - 0.5) * 0.8) * smoothstep(0.15, 0.55, fronds + cm * 0.5) : 0.0;
            diffuseColor.rgb = mix(diffuseColor.rgb, waterCoverColor * (0.75 + 0.5 * waterNoise(p * 37.0)), waterCover);
            waterFoam = max(waterFoam, waterCover * 0.999);
        }
        waterDepth = max(depth, 0.01);
        vec2 s = waterSlope(p, flow) * (1.0 + 2.0 * white) * (1.0 - 0.6 * waterFoam);
        // bubbly roughness of the white water
        s += white * (vec2(waterNoise(q * 9.0), waterNoise(q * 9.0 + 3.1)) - 0.5) * 0.6;
        waterNormal = normalize(vec3(-s.x, 1.0, -s.y));
    }
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_pars_fragment>', `#include <transmission_pars_fragment>
#ifdef USE_TRANSMISSION
${unpack ? '' : '#define WATER_NO_GBUFFER'}
${REFRACT}
#endif
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_fragment>', TRANSMISSION)
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor = mix(roughnessFactor, 0.65, waterFoam);
    roughnessFactor = mix(roughnessFactor, 0.55, waterCover);
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);
`)
        },
        computeCacheKey: () => 'water-body-1' + (opaque ? 'o' : ''),
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    m.registerMaterialExtensions(unpack ? [ext, unpack] : [ext])
    return m
}

function lookColor(look: WaterLook, depth: number, target: Color) {
    const [a, b, c] = look.depths ?? [0.25, 1.4, 3]
    const C = look.colors
    target.setRGB(...C[0]).lerp(new Color(...C[1]), smoothstep(0, a, depth))
    target.lerp(new Color(...C[2]), smoothstep(a, b, depth))
    return target.lerp(new Color(...C[3]), smoothstep(b * 0.9, b + (c - b), depth))
}

/** Builds a water body (surface + optional edge slab); call `update(t)` from the scene's animate. */
export function buildWaterBody(viewer: ThreeViewer, o: WaterBodyOptions) {
    const look = o.look ?? WATER_LOOKS.pool
    const [x0, z0, x1, z1] = o.area ?? [-o.size / 2, -o.size / 2, o.size / 2, o.size / 2]
    const nx = Math.max(2, Math.round(o.res * (x1 - x0) / o.size)), nz = Math.max(2, Math.round(o.res * (z1 - z0) / o.size))
    const sx = (x1 - x0) / nx, sz = (z1 - z0) / nz
    const levelAt = typeof o.level === 'number' ? (() => o.level as number) : o.level
    const n1x = nx + 1, n1z = nz + 1
    const pos = new Float32Array(n1x * n1z * 3)
    const col = new Float32Array(n1x * n1z * 3)
    const data = new Float32Array(n1x * n1z * 4)
    const flow = new Float32Array(n1x * n1z * 3)
    const depth = new Float32Array(n1x * n1z)
    const lev = new Float32Array(n1x * n1z)
    const inc = new Uint8Array(n1x * n1z)
    const c = new Color()
    for (let j = 0; j < n1z; j++) for (let i = 0; i < n1x; i++) {
        const k = j * n1x + i
        const x = x0 + i * sx, z = z0 + j * sz
        const L = levelAt(x, z)
        const d = L - o.height(x, z)
        depth[k] = d
        lev[k] = L
        inc[k] = (o.include ? o.include(x, z, d) : d > -0.25) ? 1 : 0
        pos.set([x, L, z], k * 3)
        lookColor(look, Math.max(0, d), c)
        col.set([c.r, c.g, c.b], k * 3)
        const f = o.flow ? o.flow(x, z) : [1, 0, 0]
        flow.set(f, k * 3)
        data.set([d, o.foam ? o.foam(x, z, d) : 0, o.shoreFoam ?? 0, o.cover ? o.cover(x, z, d) : 0], k * 4)
    }
    const index: number[] = []
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const a = j * n1x + i, b = a + 1, cc = a + n1x, dd = cc + 1
        if (!(inc[a] || inc[b] || inc[cc] || inc[dd])) continue
        if (Math.max(depth[a], depth[b], depth[cc], depth[dd]) < -0.02) continue
        const lmin = Math.min(lev[a], lev[b], lev[cc], lev[dd]), lmax = Math.max(lev[a], lev[b], lev[cc], lev[dd])
        if (lmax - lmin > 0.03 && !o.flow) continue
        if (o.maxStep !== undefined && lmax - lmin > o.maxStep) continue
        index.push(a, cc, b, b, cc, dd)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.setAttribute('waterData', new BufferAttribute(data, 4))
    g.setAttribute('waterFlow', new BufferAttribute(flow, 3))
    g.setIndex(index)
    g.computeVertexNormals()
    g.computeBoundingBox()
    g.computeBoundingSphere()
    const uniforms = waterBodyUniforms()
    const w = o.waves ?? {}
    uniforms.waterWaves.value.set(w.amplitude ?? 0.3, w.length ?? 1.2, w.speed ?? 0.6)
    if (o.coverColor) uniforms.waterCoverColor.value.setRGB(...o.coverColor)
    const material = waterBodyMaterial(viewer, look, uniforms, o.opaque)
    const surface = new Mesh(g, material)
    surface.name = o.name ?? 'Water'
    surface.receiveShadow = true

    let slab: Mesh | undefined
    if (o.slab) {
        const half = o.size / 2, step = o.size / o.res
        const sv: number[] = [], sc: number[] = [], sn: number[] = [], si: number[] = []
        const edge = (p: (t: number) => [number, number], normal: [number, number, number]) => {
            for (let t = 0; t < o.res; t++) {
                const [ax, az] = p(t), [bx, bz] = p(t + 1)
                const la = levelAt(ax, az), lb = levelAt(bx, bz)
                const ha = Math.min(la, o.height(ax, az)), hb = Math.min(lb, o.height(bx, bz))
                if (ha >= la - 0.005 && hb >= lb - 0.005) continue
                const b = sv.length / 3
                sv.push(ax, la, az, ax, ha, az, bx, lb, bz, bx, hb, bz)
                for (const [y, L] of [[la, la], [ha, la], [lb, lb], [hb, lb]]) {
                    lookColor(look, Math.max(0, L - y) + 0.3, c)
                    const k = Math.exp((y - L) * 1.5)
                    sc.push(c.r * 1.6 * k, c.g * 1.6 * k, c.b * 1.6 * k)
                    sn.push(...normal)
                }
                si.push(b, b + 1, b + 2, b + 2, b + 1, b + 3)
            }
        }
        edge(t => [-half + t * step, half], [0, 0, 1])
        edge(t => [half - t * step, -half], [0, 0, -1])
        edge(t => [half, half - t * step], [1, 0, 0])
        edge(t => [-half, -half + t * step], [-1, 0, 0])
        if (sv.length) {
            const sg = new BufferGeometry()
            sg.setAttribute('position', new BufferAttribute(new Float32Array(sv), 3))
            sg.setAttribute('normal', new BufferAttribute(new Float32Array(sn), 3))
            sg.setAttribute('color', new BufferAttribute(new Float32Array(sc), 3))
            sg.setIndex(si)
            slab = new Mesh(sg, new PhysicalMaterial({color: '#ffffff', vertexColors: true, roughness: 0.08}))
            slab.name = (o.name ?? 'Water') + ' slab'
            surface.add(slab)
        }
    }
    const added = viewer.scene.addObject(surface)
    surface.castShadow = false
    if (slab) slab.castShadow = false
    viewer.addEventListener('preFrame', () => {
        const cam = viewer.scene.mainCamera as any
        uniforms.waterNearFar.value.set(cam.near, cam.far)
    })
    const update = (t: number) => {
        uniforms.waterTime.value = t
    }
    return {surface: added as any as Mesh, slab, uniforms, material, update}
}

