import {BufferAttribute, BufferGeometry, Color, Mesh, PhysicalMaterial, ThreeViewer, Vector3} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {NOISE} from './proc'
import {Noise2, smoothstep} from './noise'

/**
 * Cut-away diorama sides with geology: the four faces of a terrain tile as one closed band of rock (the corners
 * rounded off along their diagonal), displaced outward per layer, so hard beds stand out as ledges and soft ones
 * weather back, with a turf lip at the top and the soil under it. The layers are a stack of beds in a "layer
 * coordinate" that dips and folds across the tile; the topsoil follows the surface instead. The relief and the
 * colours come from the same numbers: the vertices carry the layer coordinate, the depth below the surface and the
 * relief, and the shader reads the bed from them, so a ledge and its colour change line up.
 *
 * A bed's look is one of a few kinds (turf, soil, till with cobbles, thin-bedded rock, massive rock with joints,
 * scoria, ice), each a procedural GLSL pattern (colour, roughness, bump).
 */

export type BedKind = 'turf' | 'soil' | 'till' | 'bedded' | 'massive' | 'scoria' | 'ice' | 'ash' | 'columnar'

export interface Bed {
    kind: BedKind
    /** Thickness in metres (beds are stacked downward from the top of the layer coordinate). */
    thickness: number
    /** Linear albedo and a second tone mixed by noise. */
    color: [number, number, number]
    color2?: [number, number, number]
    /** Relief, metres: + stands out as a ledge, - weathers back. */
    relief?: number
    roughness?: number
    /** Pattern scale multiplier. */
    scale?: number
}

export interface StrataSpec {
    /** Topsoil beds that follow the surface (depth below it), top first. */
    soil: Bed[]
    /** Rock beds, top first, from `top` (in the layer coordinate) down; the last one repeats to the base. */
    beds: Bed[]
    /** Layer coordinate of the top of the first bed. */
    top: number
    /** Dip: the layer coordinate is y - dip.x * x - dip.z * z - fold. */
    dip?: [number, number]
    /** Folding: amplitude (m) and wavelength (m) along the faces. */
    fold?: [number, number]
    /** Waviness of every boundary (m). */
    wobble?: number
    seed?: number
    /** A layer coordinate of its own (replaces dip and fold), e.g. beds draped over a cone: y + k * distance. */
    layer?: (x: number, y: number, z: number) => number
    /**
     * GLSL added to the colour stage: may change `col` and set `stGlow` (emitted radiance, linear rgb) from `vStPos`
     * (world position), `vStrata` (layer coordinate, depth below the surface, relief), `p` (position on the face).
     */
    glow?: string
    /** Multiplier on the colour of the pebbles and cobbles in soil and till (default 1: pale grey stones). */
    clasts?: [number, number, number]
}

export interface CutFaceOptions {
    size: number
    /** The surface (the terrain's eroded height). */
    height: (x: number, z: number) => number
    /** y of the base. */
    bottom: number
    spec: StrataSpec
    /** Column spacing along the faces and row spacing down them (m). */
    step?: number
    rowStep?: number
    /** Turf lip overhang (m). */
    lip?: number
    /** Extra relief per point, e.g. a cave mouth (m, + outward). */
    extraRelief?: (x: number, y: number, z: number, depth: number) => number
    /** Material name suffix (one program per tile). */
    name?: string
    /** Openings in the faces (a cave mouth): a quad whose centre is inside is left out. */
    hole?: (x: number, y: number, z: number) => boolean
}

/** The bed at a layer coordinate (rock) and depth (soil): index into soil then beds, and the position in it. */
function bedAt(spec: StrataSpec, L: number, depth: number, soilJitter: number) {
    let d = 0
    for (let i = 0; i < spec.soil.length; i++) {
        d += spec.soil[i].thickness * soilJitter
        if (depth < d) return {bed: spec.soil[i], index: i, t: 1 - (d - depth) / (spec.soil[i].thickness * soilJitter)}
    }
    let top = spec.top
    for (let i = 0; i < spec.beds.length; i++) {
        const b = spec.beds[i]
        if (L > top - b.thickness || i === spec.beds.length - 1) return {bed: b, index: spec.soil.length + i, t: (top - L) / b.thickness}
        top -= b.thickness
    }
    return {bed: spec.beds[spec.beds.length - 1], index: spec.soil.length + spec.beds.length - 1, t: 0}
}

const vec3 = (c: [number, number, number]) => `vec3(${c.map(v => v.toFixed(4)).join(', ')})`

/** GLSL for the beds: colour, roughness and bump height from the bed index, local coordinate and position. */
function strataGlsl(spec: StrataSpec) {
    const beds = [...spec.soil, ...spec.beds]
    const cases = beds.map((b, i) => {
        const c1 = vec3(b.color), c2 = vec3(b.color2 ?? b.color), r = (b.roughness ?? 0.9).toFixed(3), s = (b.scale ?? 1).toFixed(3)
        return `if (id == ${i}) { stBed(${['turf', 'soil', 'till', 'bedded', 'massive', 'scoria', 'ice', 'ash', 'columnar'].indexOf(b.kind)}, ${c1}, ${c2}, ${r}, ${s}, p, t, col, rough, h); }`
    })
    return /* glsl */`
// p: position on the face (u along it, y); t: 0 at the top of the bed, 1 at its bottom
const vec3 stClast = ${vec3(spec.clasts ?? [1, 1, 1])};
void stBed(int kind, vec3 c1, vec3 c2, float r0, float sc, vec2 p, float t, inout vec3 col, inout float rough, inout float h) {
    p *= sc;
    float big = n_fbm(p * 0.35, 3);
    float mid = n_snoise(p * 2.7);
    float fine = n_snoise(p * 19.0);
    vec3 c = mix(c1, c2, smoothstep(-0.4, 0.5, big));
    rough = r0;
    if (kind == 0) {
        // turf: matted grass and roots over dark humus
        float blades = n_snoise(vec2(p.x * 40.0, p.y * 6.0));
        c = mix(c, c * vec3(0.5, 0.45, 0.35), smoothstep(0.3, 1.0, t));
        c *= 0.8 + 0.3 * blades;
        h = blades * 0.004 + mid * 0.01;
    } else if (kind == 1) {
        // soil: crumbly, with pebbles and roots
        vec3 w = n_worleyId(p * 5.0);
        float peb = 1.0 - smoothstep(0.12, 0.2, w.x);
        c *= 0.85 + 0.25 * mid;
        c = mix(c, mix(vec3(0.35, 0.33, 0.3), vec3(0.55, 0.52, 0.48), w.z) * stClast, peb * step(0.55, w.z));
        float root = 1.0 - smoothstep(0.0, 0.05, abs(n_snoise(p * vec2(1.5, 4.0)) - 0.2));
        c = mix(c, c * 0.6, root * 0.5 * (1.0 - t));
        h = mid * 0.012 + peb * step(0.55, w.z) * 0.02 * sqrt(max(0.0, 0.2 - w.x) * 5.0) - root * 0.006;
    } else if (kind == 2) {
        // till: cobbles and boulders of every size in a grey sandy matrix
        vec3 w = n_worleyId(p * 1.6 + 0.4 * vec2(n_snoise(p * 3.0), n_snoise(p * 3.0 + 5.0)));
        float stone = 1.0 - smoothstep(0.32, 0.42, w.x);
        vec3 w2 = n_worleyId(p * 6.0);
        float peb = 1.0 - smoothstep(0.18, 0.26, w2.x);
        vec3 sc1 = mix(vec3(0.22, 0.22, 0.23), vec3(0.5, 0.48, 0.45), w.z) * stClast;
        c *= 0.85 + 0.2 * fine;
        c = mix(c, sc1 * (0.85 + 0.2 * fine), stone);
        c = mix(c, mix(vec3(0.3), vec3(0.55, 0.53, 0.5), w2.z) * stClast, peb * (1.0 - stone) * 0.8);
        h = stone * 0.06 * sqrt(max(0.0, 0.42 - w.x) * 2.4) + peb * 0.012 + fine * 0.002;
        rough = mix(r0, 0.8, stone);
    } else if (kind == 3) {
        // thin-bedded rock: laminae, partings, and the odd vertical crack
        float lam = sin((t * 9.0 + 0.6 * big) * 6.2831);
        float part = 1.0 - smoothstep(0.0, 0.08, abs(fract(t * 3.0 + 0.15 * big) - 0.5) * 2.0 - 0.9);
        c *= 0.88 + 0.1 * lam + 0.12 * mid;
        c *= 1.0 - 0.35 * part;
        float crack = 1.0 - smoothstep(0.0, 0.04, abs(n_snoise(vec2(p.x * 1.3, p.y * 0.2)) ));
        c *= 1.0 - 0.4 * crack;
        h = lam * 0.006 - part * 0.02 - crack * 0.03 + fine * 0.002;
    } else if (kind == 4) {
        // massive crystalline rock (granite, gneiss): speckled, blocky joints, lichen
        float speck = n_hash12(floor(p * 60.0));
        c *= 0.9 + 0.2 * mid;
        c = mix(c, vec3(0.06), step(0.82, speck) * 0.6);
        c = mix(c, c * 1.35, step(speck, 0.12) * 0.5);
        vec3 w = n_worleyId(p * vec2(0.9, 1.4) + 0.3 * vec2(n_snoise(p), n_snoise(p + 3.0)));
        float joint = 1.0 - smoothstep(0.02, 0.07, w.y - w.x);
        c *= 1.0 - 0.55 * joint;
        float lichen = smoothstep(0.35, 0.7, n_fbm(p * 1.7 + 9.0, 3)) * (1.0 - joint);
        c = mix(c, vec3(0.38, 0.4, 0.3), lichen * 0.35);
        h = -joint * 0.05 + mid * 0.012 + fine * 0.002 + (w.z - 0.5) * 0.02;
    } else if (kind == 5) {
        // scoria and lava: vesicular, oxidised red to black
        vec3 w = n_worleyId(p * 7.0);
        float pore = 1.0 - smoothstep(0.05, 0.16, w.x);
        c *= 0.8 + 0.35 * mid;
        c *= 1.0 - 0.6 * pore;
        h = -pore * 0.012 + mid * 0.015 + fine * 0.003;
    } else if (kind == 6) {
        // glacier ice: blue, banded with dirt layers and bubbles
        float band = smoothstep(0.75, 0.95, sin((t * 5.0 + 0.4 * big) * 6.2831) * 0.5 + 0.5);
        c *= 0.85 + 0.25 * mid;
        c = mix(c, vec3(0.2, 0.2, 0.2), band * 0.35);
        h = mid * 0.01 + fine * 0.002;
        rough = r0 + 0.1 * band;
    } else if (kind == 8) {
        // a lava flow unit with columnar joints: vertical columns, rubbly top and base
        vec3 w = n_worleyId(vec2(p.x * 1.6, p.y * 0.12));
        float joint = 1.0 - smoothstep(0.02, 0.08, w.y - w.x);
        float rubble = smoothstep(0.82, 0.97, t) + smoothstep(0.12, 0.0, t);
        c *= 0.85 + 0.3 * w.z;
        c *= 1.0 - 0.6 * joint;
        vec3 w2 = n_worleyId(p * 5.0);
        c = mix(c, c * (0.6 + 0.6 * w2.z), rubble);
        float tie = 1.0 - smoothstep(0.0, 0.03, abs(fract(p.y * 2.5 + w.z * 3.0) - 0.5) - 0.47);
        c *= 1.0 - 0.3 * tie * (1.0 - rubble);
        h = -joint * 0.06 + (w.z - 0.5) * 0.03 + rubble * (1.0 - smoothstep(0.1, 0.3, w2.x)) * 0.03 + fine * 0.002;
    } else {
        // ash beds: fine, layered, pale
        float lam = sin((t * 14.0 + 0.4 * big) * 6.2831);
        c *= 0.9 + 0.08 * lam + 0.1 * mid;
        h = lam * 0.003 + mid * 0.006;
    }
    col = c;
}
void strata(int id, vec2 p, float t, inout vec3 col, inout float rough, inout float h) {
    ${cases.join('\n    else ')}
}
`
}

const VERT = /* glsl */`
attribute vec4 strata;
varying vec4 vStrata;
varying vec3 vStPos;
`

/** The face material: a PhysicalMaterial whose colour, roughness and normal come from the beds. */
export function strataMaterial(spec: StrataSpec, name = 'Cut face') {
    const m = new PhysicalMaterial({color: '#ffffff', roughness: 0.9, metalness: 0})
    m.name = name
    const beds = [...spec.soil, ...spec.beds]
    // bed boundaries in the layer coordinate, for the shader's lookup (soil by depth)
    const soilTops: number[] = [0], bedTops: number[] = [spec.top]
    for (const b of spec.soil) soilTops.push(soilTops[soilTops.length - 1] + b.thickness)
    for (const b of spec.beds) bedTops.push(bedTops[bedTops.length - 1] - b.thickness)
    const lookup = /* glsl */`
int stId; float stT;
void stLookup(float L, float depth, float jit) {
    ${spec.soil.map((b, i) => `if (depth < ${soilTops[i + 1].toFixed(3)} * jit) { stId = ${i}; stT = (depth / jit - ${soilTops[i].toFixed(3)}) / ${b.thickness.toFixed(3)}; return; }`).join('\n    ')}
    ${spec.beds.map((b, i) => `if (L > ${bedTops[i + 1].toFixed(3)} || ${i === spec.beds.length - 1 ? 'true' : 'false'}) { stId = ${spec.soil.length + i}; stT = (${bedTops[i].toFixed(3)} - L) / ${b.thickness.toFixed(3)}; return; }`).join('\n    ')}
}
`
    const key = 'strata-' + name.replace(/\W/g, '') + '-' + beds.length
    const ext: MaterialExtension = {
        parsVertexSnippet: VERT,
        parsFragmentSnippet: `varying vec4 vStrata;\nvarying vec3 vStPos;\n${NOISE}\n${strataGlsl(spec)}\n${lookup}
vec3 stBumpView(vec3 p, vec3 n, float h, float strength){
  vec3 dpdx = dFdx(p), dpdy = dFdy(p);
  float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * n - strength * grad);
}
float stH; float stRough; vec3 stGlow;
`,
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    vStrata = strata;
    vStPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    {
        // u: distance along the faces (x on the z faces, z on the x faces)
        vec2 p = vec2(abs(vStPos.x) > abs(vStPos.z) ? vStPos.z : vStPos.x, vStPos.y);
        stLookup(vStrata.x + 0.03 * n_snoise(p * 6.0), vStrata.y, vStrata.w);
        vec3 col = vec3(1.0); stRough = 0.9; stH = 0.0;
        strata(stId, p, clamp(stT, 0.0, 1.0), col, stRough, stH);
        // weathering: the beds darken under a ledge (wet, sheltered) and dust settles on the ledges
        col *= 1.0 - 0.25 * smoothstep(0.0, -0.25, vStrata.z);
        stGlow = vec3(0.0);
        ${spec.glow ?? ''}
        diffuseColor.rgb *= col;
    }
`)
            if (spec.glow) shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
    totalEmissiveRadiance += stGlow;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor = stRough;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    normal = stBumpView(-vViewPosition, normal, stH, 1.0);
`)
        },
        computeCacheKey: () => key,
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    m.registerMaterialExtensions([ext])
    return m
}

/**
 * Builds the four cut faces as one band round the tile, and a base. Returns the mesh and a lookup of the bed at a
 * point of a face (for props that sit on a ledge).
 */
export function buildCutFaces(viewer: ThreeViewer, o: CutFaceOptions) {
    const {size, spec} = o
    const half = size / 2
    const step = o.step ?? 0.25, rowStep = o.rowStep ?? 0.2
    const noise = new Noise2(spec.seed ?? 7)
    const [dx, dz] = spec.dip ?? [0, 0]
    const [famp, flen] = spec.fold ?? [0, 1]
    const wob = spec.wobble ?? 0.3
    const lip = o.lip ?? 0.12
    // perimeter, counter-clockwise seen from above: +z face (x -half..half), +x face, -z face, -x face
    const per: {x: number, z: number, nx: number, nz: number, u: number}[] = []
    const cols = Math.round(size / step)
    const pushEdge = (f: (t: number) => [number, number], nx: number, nz: number, u0: number) => {
        for (let i = 0; i < cols; i++) {
            const [x, z] = f(i / cols)
            per.push({x, z, nx, nz, u: u0 + i * step})
        }
    }
    pushEdge(t => [-half + t * size, half], 0, 1, 0)
    pushEdge(t => [half, half - t * size], 1, 0, size)
    pushEdge(t => [half - t * size, -half], 0, -1, 2 * size)
    pushEdge(t => [-half, -half + t * size], -1, 0, 3 * size)
    // corners: the outward direction is the diagonal (each face moves by the same amount)
    for (let i = 0; i < per.length; i += cols) {
        const prev = per[(i - 1 + per.length) % per.length]
        per[i].nx += prev.nx
        per[i].nz += prev.nz
    }
    const N = per.length
    let minTop = Infinity
    const tops = per.map(p => {
        const h = o.height(Math.max(-half, Math.min(half, p.x)), Math.max(-half, Math.min(half, p.z)))
        minTop = Math.min(minTop, h)
        return h
    })
    const pos: number[] = [], nrm: number[] = [], st: number[] = [], idx: number[] = []
    const rowsOf: number[] = []
    const starts: number[] = []
    // each column: rows from its top down to the bottom, a fixed row count per column (spacing varies), so the
    // band is a regular grid
    let maxRows = 0
    for (const t of tops) maxRows = Math.max(maxRows, Math.ceil((t - o.bottom) / rowStep))
    const rows = Math.min(400, maxRows)
    for (let c = 0; c < N; c++) {
        const p = per[c], top = tops[c]
        starts.push(pos.length / 3)
        rowsOf.push(rows)
        for (let r = 0; r <= rows; r++) {
            // rows packed closer near the top (turf, soil) than at the base
            const k = r / rows
            const depth = (top - o.bottom) * (k * 0.75 + 0.25 * k * k * k)
            const y = top - depth
            const L = (spec.layer ? spec.layer(p.x, y, p.z) : y - dx * p.x - dz * p.z - famp * Math.sin(p.u / flen * Math.PI * 2 + 0.7 * noise.noise(p.u * 0.05, 3.1))) +
                wob * noise.fbm(p.u * 0.08, y * 0.05, 3)
            const jit = 1 + 0.3 * noise.noise(p.u * 0.12, 3.7)
            const b = bedAt(spec, L, depth, jit)
            // relief: the bed's own, with its edges rounded off (beds weather back at their partings), blocky joints
            let rel = (b.bed.relief ?? 0) * Math.sin(Math.PI * Math.min(1, Math.max(0, b.t))) ** 0.35
            rel *= 0.6 + 0.6 * smoothstep(-0.5, 0.5, noise.fbm(p.u * 0.15 + b.index * 13, y * 0.1, 3))
            if (b.bed.kind === 'massive' || b.bed.kind === 'columnar') rel += 0.12 * Math.round(noise.noise(p.u * (b.bed.kind === 'columnar' ? 1.6 : 0.4) + 7, y * 0.25) * 3) / 3
            rel += 0.05 * noise.fbm(p.u * 0.9, y * 0.9, 2)
            if (r === 0) rel = 0
            else if (depth < 0.15) rel = lip * smoothstep(0, 0.06, depth)
            else if (o.extraRelief) rel += o.extraRelief(p.x, y, p.z, depth)
            // fade the relief out toward the base edge, so the bottom stays square
            rel *= smoothstep(0, 0.6, y - o.bottom)
            pos.push(p.x + p.nx * rel, y, p.z + p.nz * rel)
            nrm.push(p.nx, 0, p.nz)
            st.push(L, depth, rel, jit)
        }
    }
    for (let c = 0; c < N; c++) {
        const a0 = starts[c], b0 = starts[(c + 1) % N]
        for (let r = 0; r < rows; r++) {
            const a = a0 + r, b = a0 + r + 1, c1 = b0 + r, d = b0 + r + 1
            if (o.hole) {
                const cx = (pos[a * 3] + pos[d * 3]) / 2, cy = (pos[a * 3 + 1] + pos[d * 3 + 1]) / 2, cz = (pos[a * 3 + 2] + pos[d * 3 + 2]) / 2
                if (o.hole(cx, cy, cz)) continue
            }
            // outward-facing (counter-clockwise from outside)
            idx.push(a, c1, b, b, c1, d)
        }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3))
    g.setAttribute('strata', new BufferAttribute(new Float32Array(st), 4))
    g.setIndex(idx)
    g.computeVertexNormals()
    // a wrong winding shows as an inside-out band: check one face
    {
        const n = new Vector3().fromBufferAttribute(g.attributes.normal as BufferAttribute, starts[Math.floor(cols / 2)] + Math.floor(rows / 2))
        if (n.z < 0) {
            for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t }
            g.setIndex(idx)
            g.computeVertexNormals()
        }
    }
    g.computeBoundingSphere()
    const material = strataMaterial(spec, o.name ? 'Cut face: ' + o.name : 'Cut face')
    const mesh = new Mesh(g, material)
    mesh.name = 'Diorama cut faces'
    mesh.castShadow = true
    mesh.receiveShadow = true
    viewer.scene.addObject(mesh)
    // the base: a plain dark slab under the band
    const base = new Mesh(new BufferGeometry(), new PhysicalMaterial({color: new Color(0.03, 0.03, 0.03), roughness: 1}))
    {
        const bp = [-half, o.bottom, -half, half, o.bottom, -half, half, o.bottom, half, -half, o.bottom, half]
        base.geometry.setAttribute('position', new BufferAttribute(new Float32Array(bp), 3))
        base.geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]), 3))
        base.geometry.setIndex([0, 1, 2, 0, 2, 3])
        base.name = 'Diorama base'
        viewer.scene.addObject(base)
    }
    return {mesh, base, material, triangles: idx.length / 3}
}
