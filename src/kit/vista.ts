import {BufferAttribute, BufferGeometry, Color, Mesh, ThreeViewer} from 'threepipe'
import {procMaterial} from './proc'
import {smoothstep} from './noise'

/**
 * The land round a diorama tile for its eye-level views: one coarse heightfield out to the horizon, dense near the
 * tile and coarse far out (a radial warp of a square grid), that continues the tile's own edge and blends into a
 * far landform (mountain ranges, a plain). Shading is a GLSL snippet of the tile (`color`: sets `diffuseColor`
 * from `wp`, `wn`), then aerial perspective in the material itself: the albedo fades and the haze colour is
 * emitted, so the far land fades into the sky even though the scene fog is applied before the GI is composited.
 * Hide it in the studio views (`mesh.visible`).
 */

export interface VistaOptions {
    tileSize: number
    /** The ground just outside the tile (called with points outside it: clamp to the tile edge to continue it). */
    near: (x: number, z: number) => number
    /** The far landform. */
    far: (x: number, z: number) => number
    /** Distance from the tile edge over which `near` blends into `far` (m). */
    blend: number
    extent: number
    res: number
    /** GLSL: set `vec3 col` from `wp` (world position), `wn` (world normal), `edgeD` (m outside the tile). */
    color: string
    /** GLSL: set `vec3 glow` (emitted radiance) from `wp`, `wn`, `edgeD` (distant lava, lit windows); hazed like the land. */
    glow?: string
    /** Sink below the surface right at the tile edge (hides the seam under the cut faces). */
    sink?: number
    name?: string
}

export function buildVista(viewer: ThreeViewer, o: VistaOptions) {
    const {res, extent, tileSize} = o
    const half = tileSize / 2
    const n1 = res + 1
    const warp = (t: number) => Math.sign(t) * (half * 0.96 + Math.pow(Math.abs(t), 2.2) * (extent - half))
    const pos = new Float32Array(n1 * n1 * 3)
    const inside = new Uint8Array(n1 * n1)
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
        const k = j * n1 + i
        const tx = i / res * 2 - 1, tz = j / res * 2 - 1
        // a square grid whose rings grow outward from the tile's edge
        const m = Math.max(Math.abs(tx), Math.abs(tz))
        const scale = m > 0 ? warp(m) / m : 0
        const x = tx * scale, z = tz * scale
        const cx = Math.max(-half, Math.min(half, x)), cz = Math.max(-half, Math.min(half, z))
        const d = Math.hypot(x - cx, z - cz)
        const t = smoothstep(0, o.blend, d)
        let h = o.near(x, z) * (1 - t) + o.far(x, z) * t
        if (d < 1.5) h -= (o.sink ?? 0.4) * (1 - d / 1.5)
        inside[k] = Math.abs(x) < half - 0.5 && Math.abs(z) < half - 0.5 ? 1 : 0
        pos.set([x, h, z], k * 3)
    }
    const index: number[] = []
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1
        if (inside[a] && inside[b] && inside[c] && inside[d]) continue
        index.push(a, c, b, b, c, d)
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setIndex(index)
    g.computeVertexNormals()
    g.computeBoundingSphere()
    const fog = {vsFogColor: {value: new Color(0.7, 0.78, 0.9)}, vsFogDensity: {value: 0.0012}, vsHalf: {value: half}}
    const m = procMaterial({name: o.name ?? 'Vista', roughness: 0.95}, {
        key: 'vista-' + (o.name ?? 'v'),
        head: /* glsl */`float vsFog; uniform vec3 vsFogColor; uniform float vsFogDensity; uniform float vsHalf; float cyH; vec3 vsGlow;`,
        color: /* glsl */`
    vec3 wp = vCyPos; vec3 wn = normalize(vCyNrm);
    float edgeD = length(max(abs(wp.xz) - vsHalf, 0.0));
    vec3 col = vec3(0.5);
    vec3 glow = vec3(0.0);
    ${o.color}
    ${o.glow ?? ''}
    vsGlow = glow;
    diffuseColor.rgb *= col;
    cyH = n_fbm(wp.xz * 0.08, 3) * 0.6;
    float fd = length(cameraPosition - wp) * vsFogDensity;
    vsFog = 1.0 - exp(-fd * fd);
    diffuseColor.rgb *= 1.0 - vsFog;
`,
        emissive: /* glsl */`totalEmissiveRadiance += vsFogColor * vsFog + vsGlow * (1.0 - vsFog * 0.85);`,
        normal: /* glsl */`normal = cyBump(cyH, 1.0);`,
        uniforms: fog,
    })
    const mesh = new Mesh(g, m)
    mesh.name = o.name ?? 'Vista'
    viewer.scene.addObject(mesh)
    mesh.castShadow = false
    mesh.receiveShadow = true
    return {mesh, material: m, fog, triangles: index.length / 3}
}
