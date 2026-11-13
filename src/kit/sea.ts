import {BufferAttribute, BufferGeometry, Color, Mesh, PhysicalMaterial, ShaderChunk, ThreeViewer} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {smoothstep} from './noise'

/**
 * Water: a transmissive surface that refracts what is below (screen-space), absorbs along the path (Beer-Lambert), and reflects the sky and the land (Fresnel, SSR).
 * Here with an open-sea swell: ripples from 0.4 to 9 m with a scaled amplitude (`waterAmp`), so the low sun lays a
 * glitter path on it, a foam line where the sea meets the cliff foot, and a calm variant for the pools.
 */

const vert = /* glsl */`
attribute vec2 waterData;
varying vec2 vWaterData;
varying vec3 vWaterPos;
`

const frag = /* glsl */`
uniform float waterTime;
uniform float waterAmp;
uniform float waterScale;
uniform float waterOpaque;
varying vec2 vWaterData;
varying vec3 vWaterPos;
float waterFoam;
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
// Slope of the sea surface: a sum of wind waves (Gerstner-like directions spread around the wind), long to short;
// shorter waves fade with distance (they would only alias).
vec2 waterSlope(vec2 p, float dist) {
    vec2 s = vec2(0.0);
    // wind patches: the ripples are stronger in some areas than in others
    float gust = 0.55 + 0.9 * waterNoise(p * 0.004 + vec2(waterTime * 0.01, 0.0)) * waterNoise(p * 0.011 + 3.1);
    for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float a = 0.6 + 1.25 * sin(fi * 4.854 + 0.7);
        vec2 dir = vec2(cos(a), sin(a));
        float wl = 9.0 * waterScale * pow(0.77, fi);
        float k = 6.2831 / wl;
        float amp = wl * 0.0105 * waterAmp * (i < 4 ? 1.0 : gust);
        float ph = k * dot(dir, p) + sqrt(9.81 * k) * waterTime + fi * 1.7 + 2.0 * waterNoise(p * 0.03 + fi);
        // fade out waves shorter than about 4 pixels at this distance
        // a wave that changes phase by more than about a radian per pixel only aliases: fade it out
        float fade = (1.0 - smoothstep(wl * 25.0, wl * 110.0, dist)) * (1.0 - smoothstep(0.6, 2.0, fwidth(ph)));
        s += dir * (amp * k * cos(ph)) * fade;
    }
    return s;
}
`

export interface WaterOptions {
    /** Ripple amplitude scale (1 = open sea, 0.08 = a pool). */
    amp?: number
    /** Wavelength scale. */
    scale?: number
    attenuation?: Color
    attenuationDistance?: number
    /** 1: deep water turns opaque (its own blue), 0: transmissive at any depth. */
    opaque?: number
    /** Transmission (1 - the share of the water's own scattered colour). */
    transmission?: number
}

export function waterMaterial(o: WaterOptions = {}) {
    const m = new PhysicalMaterial({color: '#ffffff', roughness: 0.03, metalness: 0})
    m.name = 'Water'
    m.transmission = o.transmission ?? 1
    m.ior = 1.333
    m.thickness = 1
    m.attenuationColor = o.attenuation ?? new Color(0.1, 0.42, 0.72)
    m.attenuationDistance = o.attenuationDistance ?? 4
    m.userData.renderToGBuffer = true
    const uniforms = {waterTime: {value: 0}, waterAmp: {value: o.amp ?? 1}, waterScale: {value: o.scale ?? 1}, waterOpaque: {value: o.opaque ?? 1}}
    const ext: MaterialExtension = {
        extraUniforms: uniforms as any,
        parsVertexSnippet: vert,
        parsFragmentSnippet: frag,
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    vWaterData = waterData;
    vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    {
        float depth = vWaterData.x;
        vec2 p = vWaterPos.xz;
        vec2 warp = vec2(waterNoise(p * 1.7), waterNoise(p * 1.7 + 7.3)) - 0.5;
        vec2 q = p + warp * 0.9;
        float lace = max(waterCells(q * 3.4 + vec2(0.0, waterTime * 0.12)), 0.8 * waterCells(q * 7.9 - vec2(waterTime * 0.07, 0.0)));
        lace *= smoothstep(0.25, 0.65, waterNoise(p * 11.0 + vec2(waterTime * 0.2, 0.0)));
        float patches = smoothstep(0.25, 0.75, waterNoise(p * 0.7 + vec2(waterTime * 0.05, 0.0)) * 0.7 + waterNoise(p * 2.1) * 0.3);
        // surf on the rocks at the cliff foot: a band a few metres wide, pulsing with the swell
        float surf = 1.0 - smoothstep(0.0, 1.2 + 0.8 * sin(waterTime * 0.9 + p.x * 0.2 + p.y * 0.13), depth);
        waterFoam = clamp(surf * lace * (0.4 + 0.6 * patches) * vWaterData.y, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.6, 0.62, 0.64), waterFoam);
        waterDepth = max(depth, 0.02);
        float dist = length(cameraPosition - vWaterPos);
        vec2 s = waterSlope(p, dist) * (1.0 - 0.8 * waterFoam);
        waterNormal = normalize(vec3(-s.x, 1.0, -s.y));
    }
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_fragment>', ShaderChunk.transmission_fragment
                .replace('material.transmission = transmission;', 'material.transmission = transmission * (1.0 - waterFoam) * (1.0 - waterOpaque * smoothstep(3.0, 25.0, waterDepth));')
                .replace('material.thickness = thickness;', 'material.thickness = thickness * waterDepth;'))
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor = mix(roughnessFactor, 0.7, waterFoam);
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    normal = normalize((viewMatrix * vec4(waterNormal, 0.0)).xyz);
`)
        },
        computeCacheKey: () => 'cyclades-water-1',
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    m.registerMaterialExtensions([ext])
    return {material: m, uniforms}
}

/**
 * The sea: one surface to the horizon, its grid dense near the shore and coarse far out (a radial warp of a
 * square grid), with the depth from the land function in an attribute (foam at the cliff foot, Beer-Lambert path).
 */
export function buildSea(viewer: ThreeViewer, o: {height: (x: number, z: number) => number, center: [number, number], extent: number, res: number}) {
    const {res, extent} = o
    const n1 = res + 1
    const pos = new Float32Array(n1 * n1 * 3), col = new Float32Array(n1 * n1 * 3), data = new Float32Array(n1 * n1 * 2)
    const depth = new Float32Array(n1 * n1)
    const c = new Color()
    // the outermost ring of cells reaches 80 km, so the water meets the sky at the horizon from the clifftop
    const warp = (t: number) => Math.sign(t) * (Math.abs(t) > 0.9999 ? Math.max(80000, extent) : Math.pow(Math.abs(t), 2.6) * extent)
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
        const k = j * n1 + i
        const x = o.center[0] + warp(i / res * 2 - 1), z = o.center[1] + warp(j / res * 2 - 1)
        const d = -o.height(x, z)
        depth[k] = d
        pos.set([x, 0, z], k * 3)
        // deep Aegean blue; turquoise only where the bed is shallow
        c.setRGB(0.006, 0.026, 0.06).lerp(new Color(0.03, 0.12, 0.12), smoothstep(8, 0.5, d))
        col.set([c.r, c.g, c.b], k * 3)
        data.set([d, smoothstep(14, 2, d)], k * 2)
    }
    const index: number[] = []
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const a = j * n1 + i, b = a + 1, cc = a + n1, dd = cc + 1
        if (Math.max(depth[a], depth[b], depth[cc], depth[dd]) < -2) continue
        index.push(a, cc, b, b, cc, dd)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(n1 * n1 * 3).map((_, i) => i % 3 === 1 ? 1 : 0), 3))
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.setAttribute('waterData', new BufferAttribute(data, 2))
    g.setIndex(index)
    g.computeBoundingBox()
    g.computeBoundingSphere()
    const {material, uniforms} = waterMaterial({amp: 1, attenuation: new Color(0.05, 0.3, 0.62), attenuationDistance: 6})
    material.vertexColors = true
    const surface = new Mesh(g, material)
    surface.name = 'Sea'
    const added = viewer.scene.addObject(surface)
    surface.castShadow = false
    surface.receiveShadow = true
    return {surface: added, uniforms, material, triangles: index.length / 3}
}

/** A pool's water: a flat box top with the calm water material (depth for the absorption in the attribute). */
export function poolWater(width: number, length: number, depth: number, material: PhysicalMaterial) {
    const g = new BufferGeometry()
    const w = width / 2, l = length / 2
    g.setAttribute('position', new BufferAttribute(new Float32Array([-w, 0, -l, w, 0, -l, -w, 0, l, w, 0, l]), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array([0.03, 0.3, 0.36, 0.03, 0.3, 0.36, 0.03, 0.3, 0.36, 0.03, 0.3, 0.36]), 3))
    g.setAttribute('waterData', new BufferAttribute(new Float32Array([depth, 0, depth, 0, depth, 0, depth, 0]), 2))
    g.setIndex([0, 2, 1, 1, 2, 3])
    return new Mesh(g, material)
}
