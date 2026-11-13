import {BufferAttribute, BufferGeometry, Mesh, PhysicalMaterial, ThreeViewer, Vector3, Vector4} from 'threepipe'
import {smoothstep} from './noise'

/**
 * Sedimentary strata for the diorama tiles: one definition of the layers (thickness, colour, hardness) read by the
 * geometry in JS (relief: hard beds stand out as ledges, soft ones are undercut) and by the surface shader in GLSL
 * (colour, laminae, joints), so the cut-away sides, canyon walls and terrain tints agree.
 *
 * Also the geometry of the cut faces: {@link buildCutFaces} builds the four sides of a tile from a top-height
 * function, with any extra cut (a canyon running out of the tile) as a signed-distance function; the outline is
 * traced per grid cell (marching squares with interpolated crossings), so overhanging and curved notches come out
 * smooth, and every vertex can be displaced by the relief.
 */

export interface Stratum {
    /** Thickness in metres. */
    thick: number
    /** Linear albedo. */
    color: [number, number, number]
    /** 0 soft (shale, siltstone: recesses), 1 hard (cemented sandstone, limestone: ledges). */
    hard: number
    /** Cross-bedded sandstone (dune laminae at an angle), 0..1. */
    cross?: number
    /** Glossy (an oil seam, wet shale), 0..1: lowers the roughness and drips dark seep down the face below. */
    gloss?: number
}

export interface StrataSpec {
    /** y of the top of the first layer (the beds above it repeat the first layer). */
    top: number
    /** Layers from the top down; below the last one the list repeats. */
    layers: Stratum[]
    /** Bedding dip: the boundaries rise by dipX per metre of x and dipZ per metre of z. */
    dipX?: number
    dipZ?: number
    /** Gentle waves of the boundaries (metres). */
    warp?: number
}

const MAX = 24

/** Boundary offset at (x, z): dip and waves; the same expression as `stWarp` in GLSL. */
export function strataShift(s: StrataSpec, x: number, z: number) {
    const w = s.warp ?? 0
    return (s.dipX ?? 0) * x + (s.dipZ ?? 0) * z + w * (0.6 * Math.sin(x * 0.11 + z * 0.05 + 1.3) + 0.4 * Math.sin(x * 0.043 - z * 0.13 + 4.1))
}

/** The layer table expanded to MAX entries (the list repeated downward): top y of each, plus the bottom of the last. */
export function strataTable(s: StrataSpec) {
    const tops: number[] = [], layers: Stratum[] = []
    let y = s.top
    for (let i = 0; i < MAX; i++) {
        const L = s.layers[i % s.layers.length]
        tops.push(y)
        layers.push(L)
        y -= L.thick
    }
    return {tops, layers, bottom: y}
}

/** The layer at a point: index, position inside it (0 top, 1 bottom), the layer. Above the top: layer 0. */
export function strataAt(s: StrataSpec, x: number, y: number, z: number) {
    const tb = (s as any).__table ??= strataTable(s)
    const yy = y - strataShift(s, x, z)
    let i = 0
    while (i < MAX - 1 && yy < tb.tops[i] - tb.layers[i].thick) i++
    const L: Stratum = tb.layers[i]
    const t = Math.min(1, Math.max(0, (tb.tops[i] - yy) / L.thick))
    return {i, t, layer: L}
}

/** Linear albedo of the strata at a point (soft blend across boundaries), for terrain vertex tints. */
export function strataColor(s: StrataSpec, x: number, y: number, z: number): [number, number, number] {
    const a = strataAt(s, x, y, z)
    const L = a.layer
    // blend toward the neighbour in the outer 15 % of the layer
    const edge = Math.min(a.t, 1 - a.t) * L.thick
    if (edge > 0.12) return L.color
    const b = strataAt(s, x, a.t < 0.5 ? y + 0.25 : y - 0.25, z).layer
    const k = 0.5 * (1 - edge / 0.12)
    return [L.color[0] + (b.color[0] - L.color[0]) * k, L.color[1] + (b.color[1] - L.color[1]) * k, L.color[2] + (b.color[2] - L.color[2]) * k]
}

/**
 * Relief of a cut face (metres, outward): hard beds stand out, soft beds are undercut most in their middle, the
 * steps between them rounded.
 */
export function strataRelief(s: StrataSpec, x: number, y: number, z: number, amp = 0.35) {
    const a = strataAt(s, x, y, z)
    const L = a.layer
    let h = L.hard
    // round the step toward the neighbouring layer over 10 cm
    const d = Math.min(a.t * L.thick, (1 - a.t) * L.thick)
    if (d < 0.05) {
        const nb = strataAt(s, x, a.t < 0.5 ? y + 0.2 : y - 0.2, z).layer
        h = nb.hard + (h - nb.hard) * (0.5 + 0.5 * smoothstep(0, 0.05, d))
    }
    // soft beds recede with a shallow concave profile; hard ones keep a near-vertical face
    const undercut = (1 - L.hard) * Math.pow(Math.sin(Math.PI * a.t), 0.6)
    return amp * (h - 0.5 - 0.35 * undercut)
}

/** GLSL: uniforms and functions of a strata spec (stLayer(y') -> index, stColor, stHard), see {@link strataUniforms}. */
export const STRATA_GLSL = /* glsl */`
uniform float stTop[${MAX}];
uniform vec4 stLayer[${MAX}];
uniform vec3 stShift;
uniform float stGloss[${MAX}];
float stWarp(vec3 p){
  return stShift.x * p.x + stShift.y * p.z + stShift.z * (0.6 * sin(p.x * 0.11 + p.z * 0.05 + 1.3) + 0.4 * sin(p.x * 0.043 - p.z * 0.13 + 4.1));
}
// layer index and depth into it (0 top .. 1 bottom) at y' (y minus the warp)
int stIndex(float yy, out float t){
  int idx = ${MAX - 1};
  for (int i = 0; i < ${MAX - 1}; i++) { if (yy >= stTop[i + 1]) { idx = i; break; } }
  float top = stTop[idx], bot = idx < ${MAX - 1} ? stTop[idx + 1] : top - 2.0;
  t = clamp((top - yy) / max(1e-3, top - bot), 0.0, 1.0);
  return idx;
}
`

/** Uniform values of a strata spec for {@link STRATA_GLSL}; layer colour in xyz, w = 10 * cross (integer part) + 0.99 * hardness. */
export function strataUniforms(s: StrataSpec) {
    const tb = strataTable(s)
    // stTop[i + 1] is the bottom of layer i
    return {
        stTop: {value: tb.tops.slice()},
        stLayer: {value: tb.layers.map(L => new Vector4(L.color[0], L.color[1], L.color[2], Math.round((L.cross ?? 0) * 10) + Math.min(1, L.hard) * 0.99))},
        stShift: {value: new Vector3(s.dipX ?? 0, s.dipZ ?? 0, s.warp ?? 0)},
        stGloss: {value: tb.layers.map(L => L.gloss ?? 0)},
    }
}

export interface CutFaceOptions {
    size: number
    /** y of the bottom face. */
    bottom: number
    /** Surface height (the terrain's, so the faces meet its edge). */
    top: (x: number, z: number) => number
    /** Grid cell (m). */
    cell?: number
    /** Outward displacement at a point (m), e.g. {@link strataRelief}; tapered to 0 at the outline and the corners. */
    relief?: (x: number, y: number, z: number) => number
    /** Extra cut: signed distance, > 0 in the rock (a canyon leaving the tile). */
    cut?: (x: number, y: number, z: number) => number
    /** Distance over which the relief fades out toward the outline (m). */
    taper?: number
}

/**
 * The four cut-away sides and the bottom of a terrain tile, displaced by the relief. Non-indexed, normals from the
 * displaced surface (finite differences), so ledges shade as ledges.
 */
export function buildCutFaces(viewer: ThreeViewer, material: PhysicalMaterial, o: CutFaceOptions) {
    const half = o.size / 2, c = o.cell ?? 0.12, taper = o.taper ?? 0.5
    const pos: number[] = [], nor: number[] = [], col: number[] = []
    let maxTop = -Infinity
    for (let t = -half; t <= half; t += 0.5) {
        maxTop = Math.max(maxTop, o.top(t, -half), o.top(t, half), o.top(-half, t), o.top(half, t))
    }
    maxTop += 0.5
    const edges = [
        {p0: new Vector3(-half, 0, half), dir: new Vector3(1, 0, 0), n: new Vector3(0, 0, 1)},
        {p0: new Vector3(half, 0, -half), dir: new Vector3(-1, 0, 0), n: new Vector3(0, 0, -1)},
        {p0: new Vector3(half, 0, half), dir: new Vector3(0, 0, -1), n: new Vector3(1, 0, 0)},
        {p0: new Vector3(-half, 0, -half), dir: new Vector3(0, 0, 1), n: new Vector3(-1, 0, 0)},
    ]
    const p = new Vector3(), q = new Vector3()
    for (const e of edges) {
        const nt = Math.ceil(o.size / c), ny = Math.ceil((maxTop - o.bottom) / c)
        const ct = o.size / nt, cy = (maxTop - o.bottom) / ny
        const at = (t: number, y: number) => p.copy(e.p0).addScaledVector(e.dir, t).setY(y)
        // signed distance to the outline (> 0 solid): below the top, outside the extra cut, above the bottom
        const f = (t: number, y: number) => {
            at(t, y)
            let d = o.top(p.x, p.z) - y
            if (o.cut) d = Math.min(d, o.cut(p.x, y, p.z))
            return d
        }
        const disp = (t: number, y: number) => {
            if (!o.relief) return 0
            const d = Math.max(0, f(t, y))
            const corner = Math.min(t, o.size - t)
            at(t, y)
            return o.relief(p.x, y, p.z) * smoothstep(0, taper, d) * smoothstep(0, 0.8, corner) * smoothstep(0, 0.6, y - o.bottom)
        }
        // lattice vertices are shared by up to six triangles: cache them (crossing points are computed each time)
        const cache = new Map<number, number[]>()
        const vert = (t: number, y: number) => {
            const fi = t / ct, fj = (y - o.bottom) / cy
            const lattice = Math.abs(fi - Math.round(fi)) < 1e-6 && Math.abs(fj - Math.round(fj)) < 1e-6
            const key = lattice ? Math.round(fj) * (nt + 1) + Math.round(fi) : -1
            let v = lattice ? cache.get(key) : undefined
            if (!v) {
                // normal: the face normal tilted by the relief gradient
                const e1 = 0.04
                const gt = (disp(t + e1, y) - disp(t - e1, y)) / (2 * e1)
                const gy = (disp(t, y + e1) - disp(t, y - e1)) / (2 * e1)
                q.copy(e.n).addScaledVector(e.dir, -gt)
                q.y -= gy
                q.normalize()
                const d = disp(t, y)
                at(t, y)
                // depth below the surface / 4, for a soil crust in the shader
                const depth = Math.min(1, Math.max(0, (o.top(p.x, p.z) - y) / 4))
                p.addScaledVector(e.n, d)
                v = [p.x, p.y, p.z, q.x, q.y, q.z, depth]
                if (lattice) cache.set(key, v)
            }
            pos.push(v[0], v[1], v[2])
            nor.push(v[3], v[4], v[5])
            col.push(v[6], 0, 0)
        }
        const vals = new Float32Array((nt + 1) * (ny + 1))
        for (let j = 0; j <= ny; j++) for (let i = 0; i <= nt; i++) vals[j * (nt + 1) + i] = f(i * ct, o.bottom + j * cy)
        const poly: [number, number][] = []
        for (let j = 0; j < ny; j++) for (let i = 0; i < nt; i++) {
            const cs: [number, number, number][] = [
                [i * ct, o.bottom + j * cy, vals[j * (nt + 1) + i]],
                [(i + 1) * ct, o.bottom + j * cy, vals[j * (nt + 1) + i + 1]],
                [(i + 1) * ct, o.bottom + (j + 1) * cy, vals[(j + 1) * (nt + 1) + i + 1]],
                [i * ct, o.bottom + (j + 1) * cy, vals[(j + 1) * (nt + 1) + i]],
            ]
            if (cs.every(k => k[2] < 0)) continue
            poly.length = 0
            for (let k = 0; k < 4; k++) {
                const a = cs[k], b = cs[(k + 1) % 4]
                if (a[2] >= 0) poly.push([a[0], a[1]])
                if ((a[2] >= 0) !== (b[2] >= 0)) {
                    const s = a[2] / (a[2] - b[2])
                    poly.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s])
                }
            }
            if (poly.length < 3) continue
            // fan; counter-clockwise in (t, y), and dir x up = n for every edge, so the front faces outward
            for (let k = 1; k < poly.length - 1; k++) {
                vert(poly[0][0], poly[0][1])
                vert(poly[k][0], poly[k][1])
                vert(poly[k + 1][0], poly[k + 1][1])
            }
        }
    }
    // the bottom
    const b = o.bottom
    for (const [x, z] of [[-half, -half], [half, -half], [half, half], [-half, -half], [half, half], [-half, half]]) {
        pos.push(x, b, z)
        nor.push(0, -1, 0)
        col.push(1, 0, 0)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3))
    g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3))
    g.computeBoundingBox()
    g.computeBoundingSphere()
    const mesh = new Mesh(g, material)
    mesh.name = 'Cut faces'
    mesh.castShadow = true
    mesh.receiveShadow = true
    viewer.scene.addObject(mesh)
    return mesh
}

/**
 * A surface given as a grid function (u along, v up) -> point: positions, smooth normals from the grid (central
 * differences), indexed. `flip` reverses the winding (front faces the other way).
 */
export function gridSurface(nu: number, nv: number, at: (i: number, j: number, out: Vector3) => void, flip = false) {
    const P = new Float32Array((nu + 1) * (nv + 1) * 3)
    const v = new Vector3()
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        at(i, j, v)
        P.set([v.x, v.y, v.z], (j * (nu + 1) + i) * 3)
    }
    const idx = new Uint32Array(nu * nv * 6)
    let k = 0
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1
        if (flip) idx.set([a, b, c, b, d, c], k)
        else idx.set([a, c, b, b, c, d], k)
        k += 6
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(P, 3))
    g.setIndex(new BufferAttribute(idx, 1))
    g.computeVertexNormals()
    g.computeBoundingBox()
    g.computeBoundingSphere()
    return g
}

export interface StrataLook {
    /** Colour of dust and sand settled on up-facing ledges (linear). */
    dust?: [number, number, number]
    /** Multiplies the rock colour (darker rock in a tunnel, say). */
    tint?: [number, number, number]
    /** How much of an up-facing surface the dust covers (0..1, default 0.85). */
    dustAmount?: number
    /** Desert varnish: dark streaks running down vertical faces, 0..1. */
    varnish?: number
    /**
     * How much of a face the varnish covers (0 default: sparse streaks; 1: curtains over most of a cliff), with
     * narrow drip lines hanging from the ledges. Leave unset for the original look.
     */
    varnishCover?: number
    /**
     * Take the horizontal coordinate along a face from the vertex colour g (metres along the outline) instead of from
     * the world position and normal; for curved or ledged faces, where the normal-based one swirls.
     */
    alongFromColor?: boolean
    /** Soil crust under the surface (needs the vertex colour r = depth below the surface / 4): colour and depth (m). */
    crust?: {color: [number, number, number], depth: number}
}

/**
 * Surface hooks (kit/surface.ts) of sedimentary rock from a strata spec: each bed in its colour with laminae,
 * cross-bedding in the dune sandstones, joints in the hard beds, desert varnish streaks down vertical faces, dust on
 * ledges and, with the vertex colour, a soil crust under the surface. World space, so cut faces, canyon walls and
 * boulders cut from the same beds agree.
 */
export function strataHooks(spec: StrataSpec, look: StrataLook = {}, key = 'strata') {
    const dust = look.dust ?? [0.5, 0.33, 0.2]
    const crust = look.crust
    const v3 = (c: number[]) => `vec3(${c.map(x => x.toFixed(4)).join(', ')})`
    return {
        key,
        uniforms: strataUniforms(spec),
        head: STRATA_GLSL + /* glsl */`
float stH; float stHard; float stGl;
`,
        color: /* glsl */`
    vec3 wp = vSfW; vec3 wn = normalize(vSfWN);
    float vert = 1.0 - abs(wn.y);
    vec2 tang = normalize(vec2(-wn.z, wn.x) + vec2(1e-4, 0.0));
    float along = abs(wn.y) > 0.8 ? wp.x + wp.z * 0.37 : dot(wp.xz, tang);
${look.alongFromColor ? `    #ifdef USE_COLOR
    if (abs(wn.y) <= 0.8) along = vColor.g;
    #endif
` : ''}    float yy = wp.y - stWarp(wp) + 0.05 * n_snoise(vec2(along * 0.4, wp.y * 0.2));
    float t; int i = stIndex(yy, t);
    vec4 L = stLayer[i];
    vec3 col = L.rgb;
    float top = stTop[i], bot = i < ${MAX - 1} ? stTop[i + 1] : top - 2.0;
    float dT = top - yy, dB = yy - bot;
    if (i > 0 && dT < 0.05) col = mix(stLayer[i - 1].rgb, col, 0.5 + 0.5 * dT / 0.05);
    if (i < ${MAX - 1} && dB < 0.05) col = mix(stLayer[i + 1].rgb, col, 0.5 + 0.5 * dB / 0.05);
    float cross = floor(L.w) * 0.1;
    stHard = fract(L.w) / 0.99;
    // laminae: fine beds inside each layer
    // (the fine sine fades out where it would alias)
    float lamF = 1.0 - smoothstep(0.4, 1.2, fwidth(yy * 11.0));
    float lam = (n_snoise(vec2(along * 0.12, yy * 14.0)) * 0.6 + 0.4 * sin(yy * 45.0 + 3.0 * n_snoise(vec2(along * 0.3, yy * 3.0)))) * lamF;
    col *= 1.0 + 0.05 * lam;
    // cross-bedding: sets of laminae at an angle, alternating direction
    float set = floor(yy / 0.7);
    float dir = n_hash12(vec2(set, float(i))) > 0.5 ? 1.0 : -1.0;
    float fs = fract(yy / 0.7);
    // fades to 0 at the set and bed boundaries (a jump in a bump height draws dashed lines along it)
    float cb = cross <= 0.0 ? 0.0 : sin((yy + dir * 0.32 * along) * 30.0 + 2.0 * n_snoise(vec2(along * 0.25, yy))) * lamF
        * smoothstep(0.0, 0.1, fs) * smoothstep(1.0, 0.9, fs) * smoothstep(0.0, 0.1, min(dT, dB));
    col *= 1.0 + 0.08 * cross * cb;
    // mottling and grain
    float big = n_fbm3(wp * vec3(0.18, 0.4, 0.18), 3);
    float grain = n_snoise3(wp * 11.0);
    col *= 0.9 + 0.16 * big + 0.05 * grain;
    // joints in the hard beds: vertical cracks
    // (tall cells: the borders run nearly vertical; they stop at the bed boundaries)
    float joint = 0.0;
    if (stHard > 0.55 && vert > 0.3) {
        vec3 jw = n_worleyId(vec2(along * 0.7, yy * 0.07 + float(i) * 3.1));
        joint = (1.0 - smoothstep(0.0, 0.025, jw.y - jw.x)) * smoothstep(0.55, 0.85, stHard) * vert * smoothstep(0.0, 0.12, min(dT, dB));
        joint *= smoothstep(-0.1, 0.4, n_snoise(vec2(along * 0.3, yy * 0.4)));
    }
    col *= 1.0 - 0.18 * joint;
    // desert varnish: dark streaks down the faces, from the ledges
    float streak = smoothstep(0.42, 0.85, n_fbm(vec2(along * 0.7, wp.y * 0.045), 3) * 0.5 + 0.5);${look.varnishCover ? `
    {
        // curtains: broad, ragged at the foot; drip lines: narrow, hanging from each bed's top
        float cv = ${look.varnishCover.toFixed(3)};
        // long narrow stripes (a few dm wide, tens of metres long), gathered into curtains by a broad mask
        float stripes = smoothstep(-0.2 * cv, 0.3 - 0.2 * cv, n_snoise(vec2(along * 1.5, wp.y * 0.02)) + 0.15 * n_snoise(vec2(along * 9.0, wp.y * 0.15)));
        float mask = smoothstep(0.1 - 0.6 * cv, 0.45 - 0.6 * cv, n_snoise(vec2(along * 0.22 + 3.0, wp.y * 0.012)));
        float curtain = stripes * mask;
        float drip = smoothstep(0.55, 0.85, n_snoise(vec2(along * 3.1, float(i) * 1.7)) * 0.5 + 0.5) * exp(-dT / (0.3 + 0.6 * n_hash12(vec2(floor(along * 3.1), float(i)))));
        streak = max(streak, max(curtain * 0.95, drip));
        col = mix(col, col * vec3(0.55, 0.5, 0.5), mask * 0.35 * vert);
    }` : ''}
    col = mix(col, ${look.varnishCover ? 'vec3(0.075, 0.05, 0.04) * (0.8 + 0.5 * big)' : 'col * vec3(0.32, 0.27, 0.27)'}, ${look.varnishCover ? 'smoothstep(0.25, 0.6, streak)' : 'streak'} * vert * ${(look.varnish ?? 0.5).toFixed(3)});
    // dust and sand on ledges
    float up = smoothstep(0.5, 0.92, wn.y);
    col = mix(col, ${v3(dust)} * (0.9 + 0.2 * big), up * ${(look.dustAmount ?? 0.85).toFixed(3)});
    ${crust ? `
    #ifdef USE_COLOR
    float depth = vColor.r * 4.0 + 0.08 * n_snoise(vec2(along * 1.3, wp.y));
    float k = 1.0 - smoothstep(${(crust.depth * 0.6).toFixed(3)}, ${crust.depth.toFixed(3)}, depth);
    col = mix(col, ${v3(crust.color)} * (0.85 + 0.25 * n_snoise3(wp * 4.0)), k);
    #endif` : ''}
    // gloss: the bed itself, and seep running down the face below it
    stGl = stGloss[i];
    if (i > 0 && stGloss[i - 1] > 0.0) {
        float seep = smoothstep(0.55, 0.85, n_fbm(vec2(along * 1.6, wp.y * 0.12), 2) * 0.5 + 0.5) * (1.0 - smoothstep(0.0, 0.9 + 0.6 * n_snoise(vec2(along * 0.9, 1.0)), dT)) * vert;
        col = mix(col, vec3(0.02, 0.018, 0.015), seep * stGloss[i - 1]);
        stGl = max(stGl, seep * stGloss[i - 1]);
    }
    ${look.tint ? `col *= ${v3(look.tint)};` : ''}
    diffuseColor.rgb = col;
    stH = lam * 0.002 + cross * cb * 0.0015 + grain * 0.002 - joint * 0.003 + big * 0.03 + n_snoise3(wp * 2.5) * 0.012;
`,
        rough: /* glsl */`roughnessFactor = mix(mix(0.95, 0.82, stHard), 0.12, stGl);`,
        normal: /* glsl */`normal = sfBump(stH, 1.0);`,
    }
}

export interface CliffBandOptions {
    center: [number, number]
    /** Outline radius at angle a (radians, from +x toward +z). */
    outline: (a: number) => number
    /** Ground height at the foot (the band starts 0.4 m below it). */
    ground: (x: number, z: number) => number
    /** Height of the top (the band's lip folds onto it). */
    top: number
    /** Outward displacement (m) at a point, e.g. strata relief; clamped to >= -maxIn. */
    relief?: (x: number, y: number, z: number) => number
    maxIn?: number
    /** How far the lip reaches in over the top (m). */
    lip?: number
    /** Step-back of the outline at height y (m, grows upward). */
    inset?: (y: number) => number
    step?: number
}

/**
 * A closed cliff band round a mesa tier or a butte, as a mesh in front of the heightfield (which cannot stand
 * vertical): from below the ground at its foot up to the top, displaced by the relief (ledges and undercuts of the
 * beds), its lip folding in over the top. The heightfield must drop inside the outline by more than `lip` so the band
 * hides it. Vertex colour r = depth below the top / 4.
 */
export function buildCliffBand(viewer: ThreeViewer, material: PhysicalMaterial, o: CliffBandOptions) {
    const step = o.step ?? 0.13
    const [cx, cz] = o.center
    let circ = 0
    for (let k = 0; k < 64; k++) circ += o.outline(k / 64 * Math.PI * 2) * Math.PI * 2 / 64
    const segs = Math.max(48, Math.round(circ / step))
    const maxIn = o.maxIn ?? 0.3, lip = o.lip ?? 0.8
    const foot: number[] = []
    let minFoot = Infinity
    for (let i = 0; i <= segs; i++) {
        const a = i / segs * Math.PI * 2, R = o.outline(a)
        foot[i] = o.ground(cx + Math.cos(a) * (R + 0.15), cz + Math.sin(a) * (R + 0.15)) - 0.4
        minFoot = Math.min(minFoot, foot[i])
    }
    const rows = Math.max(8, Math.round((o.top - minFoot) / step))
    const LIP = 3
    const depth: number[] = []
    const g = gridSurface(segs, rows + LIP, (i, j, out) => {
        const a = (i % segs) / segs * Math.PI * 2, R = o.outline(a)
        const c = Math.cos(a), s = Math.sin(a)
        if (j <= rows) {
            const y = foot[i] + (o.top - foot[i]) * j / rows
            const x0 = cx + c * R, z0 = cz + s * R
            const d = o.relief ? Math.max(-maxIn, o.relief(x0, y, z0)) : 0
            // the relief fades out at the top edge so the lip meets it
            const k = Math.min(1, (o.top - y) / 0.12)
            const RR = R - (o.inset ? o.inset(y) : 0)
            out.set(cx + c * (RR + d * k), y, cz + s * (RR + d * k))
            depth[j * (segs + 1) + i] = 1
        } else {
            const k = j - rows
            const rr = R - (o.inset ? o.inset(o.top) : 0) - [0.12, 0.45, lip][k - 1]
            out.set(cx + c * rr, o.top + [0.03, 0.02, -0.03][k - 1], cz + s * rr)
            depth[j * (segs + 1) + i] = 0
        }
    })
    const col = new Float32Array(g.attributes.position.count * 3)
    for (let k = 0; k < depth.length; k++) col[k * 3] = Math.max(0, Math.min(1, depth[k]))
    g.setAttribute('color', new BufferAttribute(col, 3))
    // front faces outward: check a vertex half-way up
    const k = Math.round(rows / 2) * (segs + 1) + Math.round(segs / 4)
    const nv = new Vector3().fromBufferAttribute(g.attributes.normal, k)
    const pv = new Vector3().fromBufferAttribute(g.attributes.position, k).sub(new Vector3(cx, 0, cz)).setY(0)
    if (nv.dot(pv) < 0) {
        const idx = g.index!.array as Uint32Array
        for (let t = 0; t < idx.length; t += 3) { const a = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = a }
        g.computeVertexNormals()
    }
    // the seam column (i = 0 and i = segs) shares its position: average the normals there
    const N = g.attributes.normal
    for (let j = 0; j <= rows + LIP; j++) {
        const a = j * (segs + 1), b = a + segs
        const n = new Vector3().fromBufferAttribute(N, a).add(new Vector3().fromBufferAttribute(N, b)).normalize()
        N.setXYZ(a, n.x, n.y, n.z)
        N.setXYZ(b, n.x, n.y, n.z)
    }
    const mesh = new Mesh(g, material)
    mesh.name = 'Cliff band'
    mesh.castShadow = mesh.receiveShadow = true
    viewer.scene.addObject(mesh as any)
    return mesh
}
