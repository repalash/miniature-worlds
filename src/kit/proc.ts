import {Color, ColorRepresentation, PhysicalMaterial} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {BUMP, NOISE} from './glslNoise'

export {NOISE}

/**
 * Procedural GLSL surfaces on threepipe's PhysicalMaterial, after the material library of the "Golden Temple"
 * (Leon Lin, MIT, https://github.com/Leonxlnx/golden-temple, src/core/materials.js and glsl.js): every surface is
 * computed per pixel from its world position, so a merged mesh needs no UVs and nothing tiles.
 *
 * threepipe compiles its own shader variants, so the hooks go in through a material extension (its shaderExtender
 * sees the `#include <...>` lines before they are expanded). The vertex stage writes the world position and the
 * world normal (instanced meshes included) to `vCyPos` / `vCyNrm`. Hooks, GLSL statements:
 * - `color`: after `<color_fragment>`, changes `diffuseColor`; `rough`: after `<roughnessmap_fragment>`, changes
 *   `roughnessFactor`; `metal`: `metalnessFactor`; `normal`: after `<normal_fragment_maps>`, changes the view-space
 *   `normal` (use `cyBump(height, strength)`); `emissive`: changes `totalEmissiveRadiance`.
 * - `head`: declarations shared by the hooks (globals set in `color` and read later).
 *
 * The hook points (color, rough, metal, normal, emissive, light) follow Golden Temple's `patch()` in materials.js, so
 * this file counts as derived from it and keeps its MIT notice (see glslNoise.ts and THIRD_PARTY_NOTICES.md). The GLSL
 * noise and bump functions are in glslNoise.ts.
 */

const VERT = /* glsl */`
varying vec3 vCyPos;
varying vec3 vCyNrm;
`

const FRAG = /* glsl */`
varying vec3 vCyPos;
varying vec3 vCyNrm;
${NOISE}
${BUMP}
#define cyBump(h, s) cyBumpView(-vViewPosition, normal, (h), (s))
`

export interface ProcHooks {
    /** Unique name: the program cache key. */
    key: string
    head?: string
    color?: string
    rough?: string
    metal?: string
    normal?: string
    emissive?: string
    /** After the direct lights: can add to `reflectedLight` (the sun's shadowed `directLight` is in scope). */
    light?: string
    uniforms?: Record<string, {value: any}>
}

let hash = (s: string) => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return (h >>> 0).toString(36)
}

/** The material extension of a set of hooks (one per hook set, so materials that share it share a program). */
const extensions = new Map<string, MaterialExtension>()
export function procExtension(h: ProcHooks): MaterialExtension {
    const key = 'cy-' + h.key + '-' + hash([h.head, h.color, h.rough, h.metal, h.normal, h.emissive, h.light].join('|'))
    let ext = extensions.get(key)
    if (ext) return ext
    ext = {
        extraUniforms: (h.uniforms ?? {}) as any,
        parsVertexSnippet: VERT,
        parsFragmentSnippet: FRAG + (h.head ?? ''),
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    {
        vec4 cyW = vec4(transformed, 1.0);
        vec3 cyN = objectNormal;
        #ifdef USE_INSTANCING
        cyW = instanceMatrix * cyW;
        cyN = mat3(instanceMatrix) * cyN;
        #endif
        cyW = modelMatrix * cyW;
        vCyPos = cyW.xyz;
        vCyNrm = mat3(modelMatrix) * cyN;
    }
`)
            let fs = shader.fragmentShader
            if (h.color) fs = fs.replace('#include <color_fragment>', `#include <color_fragment>\n{\n${h.color}\n}\n`)
            if (h.rough) fs = fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n{\n${h.rough}\n}\n`)
            if (h.metal) fs = fs.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n{\n${h.metal}\n}\n`)
            if (h.normal) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n{\n${h.normal}\n}\n`)
            if (h.emissive) fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n{\n${h.emissive}\n}\n`)
            if (h.light) fs = fs.replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>\n{\n${h.light}\n}\n`)
            shader.fragmentShader = fs
        },
        computeCacheKey: () => key,
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    extensions.set(key, ext)
    return ext
}

export interface ProcParams {
    name: string
    color?: ColorRepresentation
    roughness?: number
    metalness?: number
    clearcoat?: number
    clearcoatRoughness?: number
    emissive?: ColorRepresentation
    emissiveIntensity?: number
}

/** A PhysicalMaterial with procedural hooks. `color` multiplies the procedural albedo (a tint, linear). */
export function procMaterial(p: ProcParams, hooks: ProcHooks) {
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
    m.registerMaterialExtensions([procExtension(hooks)])
    return m
}
