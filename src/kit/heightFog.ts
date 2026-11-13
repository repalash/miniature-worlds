import {ShaderChunk} from 'threepipe'

/**
 * Height fog for the tile worlds: valley mist that lies in the low ground and thins with height, on every material
 * that has scene fog (kit/stage.ts `setFog` turns it on). It replaces three's exponential-squared fog chunks for the
 * page (one world per page), so call it before the materials compile, then use FogExp2 as usual: `fog.density` is
 * the mist's density at its base level (per metre), and `fog.color` its colour, so a view can thin it (a diorama seen
 * from 50 m away needs less than an eye-level view standing in it).
 *
 * The optical depth is integrated along the view ray through density(y) = d * exp(-(y - base) / falloff), plus a
 * thin uniform haze (`haze` x d) for aerial perspective above the mist. Scene fog is applied before the GI is
 * composited, so the bounce light shows through the mist a little.
 */
export interface HeightFogOptions {
    /** Height (m) where the mist has its full density. */
    base: number
    /** Height over which the density falls to 1/e (m). */
    falloff: number
    /** Uniform haze, as a fraction of the base density. */
    haze?: number
}

let original: {pv: string, v: string, pf: string, f: string} | undefined

export function useHeightFog(o: HeightFogOptions) {
    original ??= {pv: ShaderChunk.fog_pars_vertex, v: ShaderChunk.fog_vertex, pf: ShaderChunk.fog_pars_fragment, f: ShaderChunk.fog_fragment}
    const f = (x: number) => x.toFixed(4)
    ShaderChunk.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogWorld;
#endif
`
    ShaderChunk.fog_vertex = /* glsl */`
#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    // world position from the view-space one (the inverse of the view matrix's rotation is its transpose)
    vFogWorld = transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz);
#endif
`
    ShaderChunk.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogWorld;
    #ifdef FOG_EXP2
        uniform float fogDensity;
    #else
        uniform float fogNear;
        uniform float fogFar;
    #endif
#endif
`
    ShaderChunk.fog_fragment = /* glsl */`
#ifdef USE_FOG
    #ifdef FOG_EXP2
    {
        vec3 hfC = cameraPosition, hfP = vFogWorld;
        float hfL = length(hfP - hfC);
        float hfH = ${f(o.falloff)};
        float hfEc = exp(-(hfC.y - ${f(o.base)}) / hfH), hfEp = exp(-(hfP.y - ${f(o.base)}) / hfH);
        float hfDy = hfP.y - hfC.y;
        // mean of the density profile along the ray (the limit for a level ray is the end value)
        float hfMean = abs(hfDy) > 1e-3 ? hfH * (hfEc - hfEp) / hfDy : hfEp;
        float hfTau = fogDensity * hfL * (min(hfMean, 8.0) + ${f(o.haze ?? 0.08)});
        float fogFactor = 1.0 - exp(-hfTau);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
    }
    #else
        float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif
#endif
`
}

/** Restores three's own fog chunks. */
export function restoreFog() {
    if (!original) return
    ShaderChunk.fog_pars_vertex = original.pv
    ShaderChunk.fog_vertex = original.v
    ShaderChunk.fog_pars_fragment = original.pf
    ShaderChunk.fog_fragment = original.f
}
