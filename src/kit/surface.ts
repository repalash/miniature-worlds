import {Color, ColorRepresentation, LinearSRGBColorSpace, PhysicalMaterial, RepeatWrapping, SRGBColorSpace, Texture, ThreeViewer} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {asset} from './assets'
import {NOISE} from './proc'

/**
 * Procedural surfaces for props and terrain parts (the diorama tiles), like proc.ts but with the object's
 * own frame as well as the world: the vertex stage writes
 * - `vSfW`, `vSfWN`: world position and normal;
 * - `vSfL`, `vSfLN`: the position and normal in the mesh's own frame, before the instance matrix, so a plank keeps
 *   its grain along its own length whatever way the instance turns it;
 * - `vSfSeed`: a random number per instance (0 for a plain mesh), for per-board and per-rock variation.
 *
 * Hooks are GLSL statements like proc.ts (`color` changes `diffuseColor`, `rough` `roughnessFactor`, `metal`
 * `metalnessFactor`, `normal` the view-space `normal`, `emissive` `totalEmissiveRadiance`), with two helpers:
 * `sfBump(h, strength)` (bump from a scalar height, derivative based) and `sfTri(tex, p, n, scale)` (a texture
 * sampled from three axes and blended by the normal). Textures are Poly Haven sets ({@link phTex}) bound by uniform
 * name.
 */

const VERT = /* glsl */`
varying vec3 vSfW;
varying vec3 vSfWN;
varying vec3 vSfL;
varying vec3 vSfLN;
varying float vSfSeed;
`

const FRAG = /* glsl */`
varying vec3 vSfW;
varying vec3 vSfWN;
varying vec3 vSfL;
varying vec3 vSfLN;
varying float vSfSeed;
${NOISE}
vec3 sfBumpView(vec3 p, vec3 n, float h, float strength){
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - strength * grad);
}
#define sfBump(h, s) sfBumpView(-vViewPosition, normal, (h), (s))
vec4 sfTri(sampler2D t, vec3 p, vec3 n, float s){
  vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
  return texture(t, p.zy * s) * w.x + texture(t, p.xz * s) * w.y + texture(t, p.xy * s) * w.z;
}
`

export interface SurfaceHooks {
    /** Unique name: the program cache key. */
    key: string
    head?: string
    color?: string
    rough?: string
    metal?: string
    normal?: string
    emissive?: string
    uniforms?: Record<string, {value: any}>
}

const hash = (s: string) => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return (h >>> 0).toString(36)
}

/**
 * The material extension of a set of hooks. A new extension (with its own uniform objects) per material, so materials
 * that share hooks but not uniform values (a paint colour, a rust amount) keep their own values; they still share
 * one program through the cache key.
 */
export function surfaceExtension(h: SurfaceHooks): MaterialExtension {
    const key = 'sf-' + h.key + '-' + hash([h.head, h.color, h.rough, h.metal, h.normal, h.emissive].join('|'))
    const ext: MaterialExtension = {
        extraUniforms: (h.uniforms ?? {}) as any,
        parsVertexSnippet: VERT,
        parsFragmentSnippet: FRAG + (h.head ?? ''),
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    {
        vec4 sfW = vec4(transformed, 1.0);
        mat3 sfM = mat3(modelMatrix);
        vSfSeed = 0.0;
        #ifdef USE_INSTANCING
        sfW = instanceMatrix * sfW;
        sfM = sfM * mat3(instanceMatrix);
        vSfSeed = fract(sin(dot(instanceMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        #endif
        sfW = modelMatrix * sfW;
        vSfW = sfW.xyz;
        vSfWN = normalize(sfM * objectNormal);
        vSfL = transformed;
        vSfLN = objectNormal;
    }
`)
            let fs = shader.fragmentShader
            if (h.color) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n{\n${h.color}\n}\n`)
            if (h.rough) fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n{\n${h.rough}\n}\n`)
            if (h.metal) fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n{\n${h.metal}\n}\n`)
            if (h.normal) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{\n${h.normal}\n}\n`)
            if (h.emissive) fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n{\n${h.emissive}\n}\n`)
            shader.fragmentShader = fs
        },
        computeCacheKey: () => key,
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    return ext
}

export interface SurfaceParams {
    name: string
    color?: ColorRepresentation
    roughness?: number
    metalness?: number
    clearcoat?: number
    clearcoatRoughness?: number
    emissive?: ColorRepresentation
    emissiveIntensity?: number
    side?: number
}

/** A PhysicalMaterial with surface hooks. `color` multiplies what the hooks compute. */
export function surfaceMaterial(p: SurfaceParams, hooks: SurfaceHooks) {
    const m = new PhysicalMaterial({
        color: new Color(p.color ?? '#ffffff'),
        roughness: p.roughness ?? 0.8,
        metalness: p.metalness ?? 0,
    })
    m.name = p.name
    if (p.clearcoat) {
        m.clearcoat = p.clearcoat
        m.clearcoatRoughness = p.clearcoatRoughness ?? 0.2
    }
    if (p.emissive !== undefined) {
        m.emissive = new Color(p.emissive)
        m.emissiveIntensity = p.emissiveIntensity ?? 1
    }
    if (p.side !== undefined) m.side = p.side as any
    m.registerMaterialExtensions([surfaceExtension(hooks)])
    return m
}

const PH_TEX = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg'
const texCache = new Map<string, Promise<Texture | null>>()

/** One map of a Poly Haven texture set (1k), repeat-wrapped: diff (sRGB), rough, nor_gl or disp (linear). */
export function phTex(viewer: ThreeViewer, id: string, map: 'diff' | 'rough' | 'nor_gl' | 'disp'): Promise<Texture | null> {
    const url = asset(`${PH_TEX}/1k/${id}/${id}_${map}_1k.jpg`)
    let p = texCache.get(url)
    if (!p) {
        p = viewer.load<Texture>(url).then((t) => {
            if (!t) return null
            t.wrapS = t.wrapT = RepeatWrapping
            t.colorSpace = map === 'diff' ? SRGBColorSpace : LinearSRGBColorSpace
            t.anisotropy = 8
            t.needsUpdate = true
            return t
        }).catch((e) => {
            console.warn('surface: could not load', url, e)
            return null
        })
        texCache.set(url, p)
    }
    return p
}

/** Uniforms holding Poly Haven maps, for hooks that sample them with sfTri: {name: [id, map]}. */
export async function phUniforms(viewer: ThreeViewer, maps: Record<string, [string, 'diff' | 'rough' | 'nor_gl' | 'disp']>) {
    const out: Record<string, {value: any}> = {}
    await Promise.all(Object.entries(maps).map(async([k, [id, map]]) => {
        out[k] = {value: await phTex(viewer, id, map)}
    }))
    return out
}
