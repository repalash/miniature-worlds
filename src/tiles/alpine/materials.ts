import {Color, PhysicalMaterial} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {procExtension, procMaterial, ProcHooks} from '../../kit/proc'

/**
 * Surfaces of the alpine pass, as procedural GLSL on PhysicalMaterial (world-space, no UVs; see kit/proc.ts):
 * dressed granite (the bridge's arch stones and copings), granite rubble masonry, weathered larch timber, painted
 * snow poles, the yellow hiking signs, wooden shingles. `SNOW_CAP` adds snow on the up-facing surfaces of any of
 * them, and `snowCapExtension` puts it on loaded models (rock scans).
 */

/** GLSL (in a `color` hook, after the albedo is set): snow on up-facing surfaces, `snowAmount` 0..1. */
export const snowCapGlsl = (amount: string) => /* glsl */`
    {
        vec3 swn = normalize(vCyNrm);
        float lump = n_snoise3(vCyPos * 1.7) * 0.5 + n_snoise3(vCyPos * 7.0) * 0.2;
        float sk = ${amount} * smoothstep(0.55, 0.85, swn.y + lump * 0.25);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), sk);
        cySnow = sk;
    }
`

const SNOW_HEAD = /* glsl */`float cySnow;`
const SNOW_ROUGH = /* glsl */`roughnessFactor = mix(roughnessFactor, 0.75, cySnow);`

/** Snow on top of a loaded model's materials (rock scans): `amount` 0..1, only above `minY`. */
export function snowCapExtension(amount: number, minY = -100): MaterialExtension {
    return procExtension({
        key: 'snowcap',
        head: SNOW_HEAD + `uniform float scAmount; uniform float scMinY;`,
        color: snowCapGlsl('scAmount * smoothstep(scMinY, scMinY + 1.0, vCyPos.y)'),
        rough: SNOW_ROUGH,
        uniforms: {scAmount: {value: amount}, scMinY: {value: minY}},
    })
}

// Dressed granite: grey with black biotite and white feldspar specks, each stone its own tone (vertex colour),
// tooled face, lichen on the weather side, snow on top.
const GRANITE: ProcHooks = {
    key: 'granite',
    head: /* glsl */`float cyH;` + SNOW_HEAD,
    color: /* glsl */`
    vec3 wp = vCyPos;
    // biotite and feldspar specks, faded out where they would alias (smaller than about a pixel)
    float speck = n_hash13(floor(wp * 45.0));
    float sharp = 1.0 - clamp(length(fwidth(wp)) * 45.0 - 0.5, 0.0, 1.0);
    float big = n_fbm3(wp * 0.6, 3);
    vec3 c = vec3(0.27, 0.265, 0.255) * (0.9 + 0.15 * big);
    c = mix(c, vec3(0.06), step(0.88, speck) * 0.5 * sharp);
    c = mix(c, vec3(0.55, 0.53, 0.5), step(speck, 0.08) * 0.4 * sharp);
    float lichen = smoothstep(0.3, 0.75, n_fbm3(wp * 2.2 + 5.0, 3)) * smoothstep(-0.2, 0.6, normalize(vCyNrm).x - normalize(vCyNrm).z * 0.3);
    c = mix(c, vec3(0.55, 0.53, 0.32), lichen * 0.45);
    float soot = smoothstep(0.2, 0.8, n_fbm3(wp * vec3(3.0, 0.3, 3.0), 3) * 0.5 + 0.5) * (1.0 - abs(normalize(vCyNrm).y));
    c *= 1.0 - 0.18 * soot;
    diffuseColor.rgb *= c;
    cyH = n_snoise3(wp * 9.0) * 0.0015 + n_snoise3(wp * 40.0) * 0.0004 + big * 0.003;
` + snowCapGlsl('0.0'),
    rough: /* glsl */`roughnessFactor = 0.82 + 0.1 * n_snoise3(vCyPos * 4.0);` + SNOW_ROUGH,
    normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
}

/** Granite with snow on top (the copings, the parapet). */
const graniteSnow = (amount: number): ProcHooks => ({...GRANITE, key: 'granite-snow' + amount, color: GRANITE.color!.replace(snowCapGlsl('0.0'), snowCapGlsl(amount.toFixed(2)))})

// Rubble masonry: split granite stones of many sizes, deep raked joints of grey lime mortar.
const RUBBLE: ProcHooks = {
    key: 'rubble',
    head: /* glsl */`float cyH; float cyMortar;` + SNOW_HEAD,
    color: /* glsl */`
    vec3 wp = vCyPos; vec3 wn = normalize(vCyNrm);
    vec2 p = abs(wn.y) > 0.6 ? wp.xz : vec2(dot(wp.xz, normalize(vec2(wn.z, -wn.x) + 1e-4)), wp.y);
    vec2 q = p * vec2(2.4, 3.4) + 0.22 * vec2(n_snoise(p * 1.8), n_snoise(p * 1.8 + 3.0));
    vec3 w = n_worleyId(q);
    float e = w.y - w.x;
    cyMortar = 1.0 - smoothstep(0.05, 0.12, e);
    float id = w.z;
    vec3 stone = mix(vec3(0.07, 0.068, 0.065), vec3(0.24, 0.225, 0.21), id);
    stone = mix(stone, stone * vec3(1.1, 0.95, 0.8), step(0.8, id) * 0.6);
    stone *= 0.8 + 0.3 * (n_snoise(p * 14.0 + id * 31.0) * 0.5 + 0.5);
    float lichen = smoothstep(0.35, 0.8, n_fbm(p * 1.4 + id * 7.0, 3));
    stone = mix(stone, vec3(0.5, 0.5, 0.33), lichen * 0.35);
    vec3 mortar = vec3(0.2, 0.195, 0.185) * (0.8 + 0.2 * n_snoise(p * 11.0));
    diffuseColor.rgb *= mix(stone, mortar, cyMortar);
    cyH = (1.0 - cyMortar) * 0.03 * sqrt(clamp(e * 3.0, 0.0, 1.0)) + n_snoise(p * 25.0) * 0.001;
` + snowCapGlsl('0.0'),
    rough: /* glsl */`roughnessFactor = mix(0.85, 0.95, cyMortar);` + SNOW_ROUGH,
    normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
}

// Weathered larch: silver-grey on the weather faces, brown in the shelter, open grain and checks along `axis`.
const timber = (axis: 'x' | 'y' | 'z', snow = 0): ProcHooks => {
    const sc = axis === 'x' ? 'vec3(0.35, 16.0, 16.0)' : axis === 'y' ? 'vec3(16.0, 0.35, 16.0)' : 'vec3(16.0, 16.0, 0.35)'
    return {
        key: 'timber' + axis + snow,
        head: /* glsl */`float cyH;` + SNOW_HEAD,
        color: /* glsl */`
    vec3 wp = vCyPos; vec3 wn = normalize(vCyNrm);
    float g = n_fbm3(wp * ${sc}, 4);
    float rings = mix(sin(g * 22.0) * 0.5 + 0.5, 0.5, clamp(fwidth(g * 22.0) * 0.6, 0.0, 1.0));
    float big = n_fbm3(wp * 0.7, 3);
    float check = 1.0 - smoothstep(0.0, 0.06, abs(n_snoise(vec2(dot(wp, vec3(${axis === 'x' ? '0.4, 0.0, 0.0' : axis === 'y' ? '0.0, 0.4, 0.0' : '0.0, 0.0, 0.4'})), dot(wp, vec3(${axis === 'y' ? '9.0, 0.0, 9.0' : axis === 'x' ? '0.0, 9.0, 9.0' : '9.0, 9.0, 0.0'}))))));
    // weathering: grey where rain and sun reach (up and toward the sun side), brown under the eaves
    float weather = smoothstep(-0.5, 0.6, wn.y * 0.6 + big * 0.6 + 0.2);
    vec3 brown = vec3(0.2, 0.13, 0.08), grey = vec3(0.3, 0.29, 0.27);
    vec3 col = mix(brown, grey, weather) * (0.72 + 0.4 * rings);
    col *= 1.0 - 0.55 * check;
    diffuseColor.rgb *= col;
    cyH = (rings * 0.5 + g * 0.3) * 0.002 - check * 0.002;
` + snowCapGlsl(snow.toFixed(2)),
        rough: /* glsl */`roughnessFactor = clamp(0.75 + 0.15 * cyH * 300.0, 0.6, 1.0);` + SNOW_ROUGH,
        normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
    }
}

// Snow poles: red and white bands, chipped paint.
const POLE: ProcHooks = {
    key: 'snowpole',
    color: /* glsl */`
    float band = step(0.5, fract(vCyPos.y / 0.5 + 0.01));
    float chip = smoothstep(0.62, 0.66, n_fbm3(vCyPos * vec3(30.0, 6.0, 30.0), 3) * 0.5 + 0.5);
    vec3 c = mix(vec3(0.55, 0.035, 0.03), vec3(0.78, 0.78, 0.76), band);
    diffuseColor.rgb *= mix(c, vec3(0.3, 0.27, 0.24), chip);
`,
    rough: /* glsl */`roughnessFactor = 0.45;`,
}

// Wooden shingles: rows of split larch shakes, each its own tone, grey and mossy, with snow.
const shingles = (snow: number): ProcHooks => ({
    key: 'shingles' + snow,
    head: /* glsl */`float cyH;` + SNOW_HEAD,
    color: /* glsl */`
    vec3 wp = vCyPos; vec3 wn = normalize(vCyNrm);
    // along the slope (down) and across: the roof faces x or z
    vec2 p = abs(wn.x) > abs(wn.z) ? vec2(wp.z, wp.y / max(0.3, abs(wn.y)) ) : vec2(wp.x, wp.y / max(0.3, abs(wn.y)));
    float row = floor(p.y / 0.12);
    float u = p.x / 0.16 + n_hash12(vec2(row, 3.0)) * 7.0;
    float col = floor(u);
    float id = n_hash12(vec2(col, row));
    float fy = fract(p.y / 0.12), fx = fract(u);
    float gap = 1.0 - smoothstep(0.0, 0.06, min(fx, 1.0 - fx));
    vec3 c = mix(vec3(0.26, 0.24, 0.22), vec3(0.42, 0.39, 0.35), id) * (0.85 + 0.3 * fy);
    float moss = smoothstep(0.4, 0.8, n_fbm(p * 1.3, 3) * 0.5 + 0.5);
    c = mix(c, vec3(0.2, 0.24, 0.1), moss * 0.4);
    c *= 1.0 - 0.6 * gap;
    diffuseColor.rgb *= c;
    cyH = fy * 0.008 - gap * 0.004 + n_snoise(vec2(fx * 4.0 + id * 10.0, p.y * 40.0)) * 0.0006;
` + snowCapGlsl(snow.toFixed(2)),
    rough: /* glsl */`roughnessFactor = 0.85;` + SNOW_ROUGH,
    normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
})

// Lime-washed render on the hut's ground floor: rough, flaking to the rubble beneath.
const RENDER: ProcHooks = {
    key: 'render',
    head: /* glsl */`float cyH;`,
    color: /* glsl */`
    vec3 wp = vCyPos;
    float big = n_fbm3(wp * 0.5, 3);
    float flake = smoothstep(0.7, 0.73, n_fbm3(wp * 1.1 + 4.0, 3) * 0.5 + 0.5 + 0.08 * n_snoise3(wp * 8.0));
    vec3 c = vec3(0.72, 0.7, 0.65) * (0.92 + 0.1 * big);
    float streak = smoothstep(0.3, 0.8, n_fbm3(wp * vec3(3.0, 0.2, 3.0), 3) * 0.5 + 0.5);
    c *= 1.0 - 0.12 * streak;
    vec3 w = n_worleyId(vec2(wp.x + wp.z, wp.y) * 3.0);
    vec3 stone = mix(vec3(0.25), vec3(0.42, 0.4, 0.37), w.z);
    diffuseColor.rgb *= mix(c, stone, flake);
    cyH = n_snoise3(wp * 6.0) * 0.003 - flake * 0.006;
`,
    rough: /* glsl */`roughnessFactor = 0.92;`,
    normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
}

// Gravel on the bridge deck (matches the road layer's tone).
const GRAVEL: ProcHooks = {
    key: 'gravel',
    head: /* glsl */`float cyH;`,
    color: /* glsl */`
    vec3 gn = normalize(vCyNrm);
    vec2 p = abs(gn.y) > 0.6 ? vCyPos.xz : (abs(gn.x) > abs(gn.z) ? vCyPos.zy : vCyPos.xy);
    vec3 w = n_worleyId(p * 26.0);
    float stone = 1.0 - smoothstep(0.3, 0.55, w.x);
    vec3 c = mix(vec3(0.13, 0.115, 0.1), mix(vec3(0.14, 0.13, 0.12), vec3(0.22, 0.21, 0.195), w.z), stone);
    c *= 0.8 + 0.35 * smoothstep(-0.4, 0.6, n_fbm(p * 0.8, 3));
    c *= 0.85 + 0.25 * n_snoise(p * 2.0);
    diffuseColor.rgb *= c;
    cyH = stone * 0.004 * sqrt(max(0.0, 0.45 - w.x) * 2.2);
`,
    rough: /* glsl */`roughnessFactor = 0.95;`,
    normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
}

// Old avalanche snow: firn with dirt streaks and stones, sun cups on top.
const FIRN: ProcHooks = {
    key: 'firn',
    head: /* glsl */`float cyH;`,
    color: /* glsl */`
    vec3 wp = vCyPos;
    float cups = n_worleyId(wp.xz * 2.2).x;
    float dirt = smoothstep(0.3, 0.8, n_fbm3(wp * vec3(0.8, 4.0, 0.8), 4) * 0.5 + 0.5) + 0.3 * smoothstep(0.6, 0.9, n_fbm3(wp * 3.0, 3) * 0.5 + 0.5);
    vec3 c = vec3(0.8, 0.82, 0.86) * (0.92 + 0.08 * cups);
    c = mix(c, vec3(0.42, 0.39, 0.35), clamp(dirt, 0.0, 1.0) * 0.45);
    diffuseColor.rgb *= c;
    cyH = cups * 0.03 + n_snoise3(wp * 12.0) * 0.002;
`,
    rough: /* glsl */`roughnessFactor = 0.7;`,
    normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
}

export interface AlpineMaterials {
    granite: PhysicalMaterial
    graniteSnow: PhysicalMaterial
    rubble: PhysicalMaterial
    timberX: PhysicalMaterial
    timberY: PhysicalMaterial
    timberZ: PhysicalMaterial
    timberSnowX: PhysicalMaterial
    pole: PhysicalMaterial
    sign: PhysicalMaterial
    signText: PhysicalMaterial
    shingles: PhysicalMaterial
    render: PhysicalMaterial
    shutter: PhysicalMaterial
    glass: PhysicalMaterial
    iron: PhysicalMaterial
    gravel: PhysicalMaterial
    dark: PhysicalMaterial
    firn: PhysicalMaterial
}

export function alpineMaterials(): AlpineMaterials {
    const sign = new PhysicalMaterial({color: new Color(0.75, 0.48, 0.02), roughness: 0.4, metalness: 0})
    sign.name = 'Hiking sign'
    const signText = new PhysicalMaterial({color: new Color(0.02, 0.02, 0.02), roughness: 0.5, metalness: 0})
    signText.name = 'Sign text'
    const glass = new PhysicalMaterial({color: new Color(0.02, 0.025, 0.03), roughness: 0.05, metalness: 0})
    glass.name = 'Window glass'
    glass.emissive = new Color('#ffb466')
    glass.emissiveIntensity = 0
    const iron = new PhysicalMaterial({color: new Color(0.05, 0.045, 0.04), roughness: 0.6, metalness: 0.7})
    iron.name = 'Iron'
    const dark = new PhysicalMaterial({color: new Color(0.03, 0.025, 0.02), roughness: 0.9})
    dark.name = 'Interior'
    return {
        granite: procMaterial({name: 'Granite', color: '#ffffff', roughness: 0.82}, GRANITE),
        graniteSnow: procMaterial({name: 'Granite, snow', color: '#ffffff', roughness: 0.82}, graniteSnow(1)),
        rubble: procMaterial({name: 'Rubble masonry', roughness: 0.9}, RUBBLE),
        timberX: procMaterial({name: 'Larch x', roughness: 0.8}, timber('x')),
        timberY: procMaterial({name: 'Larch y', roughness: 0.8}, timber('y')),
        timberZ: procMaterial({name: 'Larch z', roughness: 0.8}, timber('z')),
        timberSnowX: procMaterial({name: 'Larch x, snow', roughness: 0.8}, timber('x', 1)),
        pole: procMaterial({name: 'Snow pole', roughness: 0.45}, POLE),
        sign,
        signText,
        shingles: procMaterial({name: 'Shingles', roughness: 0.85}, shingles(0.45)),
        render: procMaterial({name: 'Lime render', roughness: 0.92}, RENDER),
        shutter: procMaterial({name: 'Shutters', color: new Color(0.42, 0.06, 0.04), roughness: 0.6}, timber('y')),
        glass,
        iron,
        gravel: procMaterial({name: 'Deck gravel', color: new Color(0.75, 0.72, 0.68), roughness: 0.95}, GRAVEL),
        dark,
        firn: procMaterial({name: 'Firn', roughness: 0.7}, FIRN),
    }
}
