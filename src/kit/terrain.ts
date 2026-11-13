import {
    BufferAttribute,
    BufferGeometry,
    Color,
    DataArrayTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    LinearSRGBColorSpace,
    Mesh,
    PhysicalMaterial,
    RepeatWrapping,
    SRGBColorSpace,
    ThreeViewer,
    UnsignedByteType,
    Vector3,
} from 'threepipe'
import type {MaterialExtension} from 'threepipe'
import {asset} from './assets'
import {clamp01} from './noise'
import {erode, ErosionMasks, ErosionOptions} from './erosion'

/**
 * Runtime terrain for the world scenes, built like a game-engine landscape: a heightfield mesh with up to four
 * scanned ground layers (Poly Haven, CC0) blended per pixel by painted weights and the layers' own height maps
 * (height blending, so sand fills the gaps between stones instead of a soft cross-fade). Layer 3 is projected
 * from three axes, for cliff faces. The layers are packed into two texture arrays (albedo + roughness, normal +
 * height), so the material needs two samplers, whatever the layer count.
 *
 * The weights and a tint are vertex attributes, filled by a rule function from the height, the slope and any
 * masks the scene computes, so a world is a height function plus a few rules.
 */

export interface TerrainLayer {
    /** Poly Haven texture id (https://polyhaven.com/textures), or a custom set of urls. */
    id: string
    /** Size of one texture tile in meters. */
    tile: number
    /** Multiplies the albedo (linear). */
    tint?: [number, number, number]
    /** Multiplies the roughness. */
    roughness?: number
    /** Normal strength. */
    normal?: number
}

export interface TerrainSample {
    x: number
    z: number
    h: number
    /** 0 flat, 1 vertical. */
    slope: number
    /** Upward normal, world space. */
    n: Vector3
    /** Erosion masks, 0..1 (0 without erosion): water flow, sediment laid down, material washed out, talus. */
    flow: number
    deposit: number
    eroded: number
    talus: number
}

export interface TerrainOptions {
    /** Square tile size in meters, centred on the origin. */
    size: number
    /** Grid segments per side. */
    res: number
    height: (x: number, z: number) => number
    layers: TerrainLayer[]
    /** Fills w (one weight per layer, any scale) and tint (linear rgb multiplier, default 1) for a sample. */
    paint: (s: TerrainSample, w: number[], tint: number[]) => void
    /** Depth of the diorama base below the lowest point; 0 for no sides. */
    base?: number
    /** Texture of the diorama sides (cut soil), a Poly Haven id. */
    sideLayer?: TerrainLayer
    /** Texture resolution per layer: 1k or 2k. */
    textureRes?: '1k' | '2k'
    /**
     * Erosion of the sampled heights (kit/erosion.ts). The masks it records reach `paint` in the sample and the
     * scatter through `Terrain.mask`, and `Terrain.height` then follows the eroded surface.
     */
    erosion?: ErosionOptions
    /**
     * A mesh finer than the height grid where the views need it: `res` segments per side, placed by `x` and `z`
     * (each maps 0..1 to -size/2..size/2, increasing; dense where its slope is low). The heights, the erosion masks
     * and the paint are sampled from the grid at each vertex. Without it the mesh is the grid.
     */
    mesh?: {res: number, x: (t: number) => number, z?: (t: number) => number}
    /** Fine relief added to the mesh only (not to `Terrain.height`): rock detail on the faces. */
    relief?: (x: number, z: number, h: number, slope: number) => number
    /**
     * GLSL hooks on the terrain material: `color` runs after the vertex colour (changes `diffuseColor`, sees `talb`,
     * `terrainW`, `vTerrainPos`, `terrainWorldNormal`), `normal` after the layer normals (changes the view-space
     * `normal`); `head` holds their declarations.
     */
    shader?: {head?: string, color?: string, normal?: string, uniforms?: Record<string, {value: any}>}
}

const PH_TEX = 'https://dl.polyhaven.org/file/ph-assets/Textures/jpg'

async function loadPixels(url: string, size: number): Promise<Uint8ClampedArray | undefined> {
    try {
        const res = await fetch(asset(url))
        if (!res.ok) throw new Error(res.status + ' ' + url)
        const bmp = await createImageBitmap(await res.blob())
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = size
        const ctx = canvas.getContext('2d', {willReadFrequently: true})!
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bmp, 0, 0, size, size)
        bmp.close()
        return ctx.getImageData(0, 0, size, size).data
    } catch (e) {
        console.warn('terrain: could not load', url, e)
        return undefined
    }
}

/** Poly Haven texture set for a layer: diffuse, roughness, GL normal, displacement. */
async function loadLayer(l: TerrainLayer, res: string, size: number) {
    const base = `${PH_TEX}/${res}/${l.id}/${l.id}`
    const [diff, rough, nor, disp] = await Promise.all([
        loadPixels(`${base}_diff_${res}.jpg`, size),
        loadPixels(`${base}_rough_${res}.jpg`, size),
        loadPixels(`${base}_nor_gl_${res}.jpg`, size),
        loadPixels(`${base}_disp_${res}.jpg`, size),
    ])
    return {diff, rough, nor, disp}
}

function arrayTexture(data: Uint8Array<ArrayBuffer>, size: number, depth: number, srgb: boolean) {
    const t = new DataArrayTexture(data, size, size, depth)
    t.format = 1023 // RGBAFormat
    t.type = UnsignedByteType
    t.wrapS = t.wrapT = RepeatWrapping
    t.minFilter = LinearMipmapLinearFilter
    t.magFilter = LinearFilter
    t.generateMipmaps = true
    t.anisotropy = 8
    t.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace
    t.needsUpdate = true
    return t
}

/** Packs the layers into two RGBA texture arrays: albedo + roughness, normal + height. */
export async function loadTerrainLayers(layers: TerrainLayer[], res: '1k' | '2k' = '1k') {
    const size = res === '2k' ? 2048 : 1024
    const n = Math.min(4, layers.length)
    const loaded = await Promise.all(layers.slice(0, n).map(l => loadLayer(l, res, size)))
    const px = size * size
    const albedo = new Uint8Array(px * 4 * 4)
    const normal = new Uint8Array(px * 4 * 4)
    for (let i = 0; i < 4; i++) {
        const L = loaded[i]
        const a = i * px * 4
        for (let p = 0; p < px; p++) {
            const o = p * 4
            albedo[a + o] = L?.diff ? L.diff[o] : 128
            albedo[a + o + 1] = L?.diff ? L.diff[o + 1] : 128
            albedo[a + o + 2] = L?.diff ? L.diff[o + 2] : 128
            albedo[a + o + 3] = L?.rough ? L.rough[o] : 200
            normal[a + o] = L?.nor ? L.nor[o] : 128
            normal[a + o + 1] = L?.nor ? L.nor[o + 1] : 128
            normal[a + o + 2] = L?.nor ? L.nor[o + 2] : 255
            normal[a + o + 3] = L?.disp ? L.disp[o] : 128
        }
    }
    return {albedo: arrayTexture(albedo, size, 4, true), normal: arrayTexture(normal, size, 4, false)}
}

const terrainVert = /* glsl */`
attribute vec4 splat;
varying vec4 vSplat;
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;
`

const terrainFrag = /* glsl */`
uniform highp sampler2DArray terrainAlbedo;
uniform highp sampler2DArray terrainNormal;
uniform vec4 terrainTile;
uniform vec4 terrainRough;
uniform vec4 terrainNormalScale;
uniform vec3 terrainTint[4];
uniform float terrainBlendDepth;
varying vec4 vSplat;
varying vec3 vTerrainPos;
varying vec3 vTerrainNormal;

vec3 terrainWorldNormal;
vec4 terrainW;

// Two samples of a layer at different scales and rotations, mixed by a low-frequency pattern: hides tiling.
vec4 terrainSample(highp sampler2DArray tex, vec2 uv, float layer) {
    vec4 a = texture(tex, vec3(uv, layer));
    vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.43 + 0.37;
    vec4 b = texture(tex, vec3(uv2, layer));
    float m = smoothstep(0.35, 0.65, 0.5 + 0.5 * sin(uv.x * 0.31 + 1.7 * sin(uv.y * 0.23)) * cos(uv.y * 0.27 - 1.3 * sin(uv.x * 0.19)));
    return mix(a, b, m * 0.6);
}

// Triplanar weights from the world normal, sharpened.
vec3 terrainTriW(vec3 n) {
    vec3 w = pow(abs(n), vec3(6.0));
    return w / (w.x + w.y + w.z);
}
`

/**
 * A PhysicalMaterial with the terrain splat extension. Albedo, roughness and normal come from the layer arrays;
 * the vertex color multiplies the albedo (tint).
 */
export function terrainMaterial(layers: TerrainLayer[], textures: {albedo: DataArrayTexture, normal: DataArrayTexture}, hooks: TerrainOptions['shader'] = {}) {
    const m = new PhysicalMaterial({color: '#ffffff', roughness: 1, metalness: 0})
    m.vertexColors = true
    m.name = 'Terrain'
    const pad = <T>(f: (l: TerrainLayer) => T, d: T) => [0, 1, 2, 3].map(i => layers[i] ? f(layers[i]) : d)
    const tiles = pad(l => 1 / l.tile, 1)
    const rough = pad(l => l.roughness ?? 1, 1)
    const nrm = pad(l => l.normal ?? 1, 1)
    const tints = pad(l => new Vector3(...l.tint ?? [1, 1, 1]), new Vector3(1, 1, 1))
    const uniforms = {
        terrainAlbedo: {value: textures.albedo},
        terrainNormal: {value: textures.normal},
        terrainTile: {value: tiles},
        terrainRough: {value: rough},
        terrainNormalScale: {value: nrm},
        terrainTint: {value: tints},
        terrainBlendDepth: {value: 0.25},
        ...hooks.uniforms,
    }
    let hookKey = 0
    if (hooks.head || hooks.color || hooks.normal) for (const s of [hooks.head, hooks.color, hooks.normal].join('|')) hookKey = (Math.imul(hookKey, 31) + s.charCodeAt(0)) | 0
    const ext: MaterialExtension = {
        extraUniforms: uniforms as any,
        parsVertexSnippet: terrainVert,
        parsFragmentSnippet: terrainFrag + (hooks.head ?? ''),
        shaderExtender: (shader) => {
            shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
    vSplat = splat;
    vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
    terrainWorldNormal = normalize(vTerrainNormal);
    vec2 tuv = vTerrainPos.xz;
    vec3 tw3 = terrainTriW(terrainWorldNormal);
    vec4 tA[4];
    vec4 tN[4];
    for (int i = 0; i < 3; i++) {
        vec2 uv = tuv * terrainTile[i];
        tA[i] = terrainSample(terrainAlbedo, uv, float(i));
        tN[i] = terrainSample(terrainNormal, uv, float(i));
    }
    {
        // Layer 3 (cliffs): triplanar.
        float s = terrainTile[3];
        vec4 ax = terrainSample(terrainAlbedo, vTerrainPos.zy * s, 3.0);
        vec4 ay = terrainSample(terrainAlbedo, vTerrainPos.xz * s, 3.0);
        vec4 az = terrainSample(terrainAlbedo, vTerrainPos.xy * s, 3.0);
        tA[3] = ax * tw3.x + ay * tw3.y + az * tw3.z;
        vec4 nx = terrainSample(terrainNormal, vTerrainPos.zy * s, 3.0);
        vec4 ny = terrainSample(terrainNormal, vTerrainPos.xz * s, 3.0);
        vec4 nz = terrainSample(terrainNormal, vTerrainPos.xy * s, 3.0);
        tN[3] = nx * tw3.x + ny * tw3.y + nz * tw3.z;
        // Keep the projected normals apart for the normal step below.
        tN[3].xyz = vec3(0.5, 0.5, 1.0);
    }
    // Height blending: a layer wins where its own height map stands above the others.
    vec4 tw = max(vSplat, vec4(0.0));
    tw /= max(1e-4, tw.x + tw.y + tw.z + tw.w);
    // Layers without weight never win (they could, by their height map alone, and leave no weight at all).
    vec4 tpresent = step(vec4(1e-3), tw);
    vec4 th = vec4(tN[0].a, tN[1].a, tN[2].a, tN[3].a) + tw * 1.5 - (1.0 - tpresent) * 10.0;
    float tmax = max(max(th.x, th.y), max(th.z, th.w));
    tw = max(th - (tmax - terrainBlendDepth), vec4(0.0)) * tpresent;
    tw /= max(1e-4, tw.x + tw.y + tw.z + tw.w);
    terrainW = tw;
    vec3 talb = vec3(0.0);
    float trough = 0.0;
    for (int i = 0; i < 4; i++) {
        talb += tA[i].rgb * terrainTint[i] * tw[i];
        trough += tA[i].a * terrainRough[i] * tw[i];
    }
    diffuseColor.rgb *= talb;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
    #ifdef TERRAIN_NAN_DEBUG
    if (any(isnan(gl_FragColor)) || any(isinf(gl_FragColor))) gl_FragColor = vec4(100.0, 0.0, 100.0, 1.0);
    #endif
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
    float roughnessFactor = roughness * trough;
`)
            shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
    {
        // Whiteout-blended planar normals for layers 0-2 (projected on xz), triplanar for layer 3, in world space.
        vec3 n = terrainWorldNormal;
        vec3 wn = vec3(0.0);
        for (int i = 0; i < 3; i++) {
            if (tw[i] <= 0.0) continue; // 0 * NaN is NaN: skip, do not weight
            vec3 t = tN[i].xyz * 2.0 - 1.0;
            t.xy *= terrainNormalScale[i];
            vec3 ny = vec3(t.x + n.x, abs(n.y) * t.z, -t.y + n.z);
            wn += ny * (tw[i] * inversesqrt(max(dot(ny, ny), 1e-8)));
        }
        if (tw.w > 0.0) {
            float s = terrainTile[3];
            vec3 tx = texture(terrainNormal, vec3(vTerrainPos.zy * s, 3.0)).xyz * 2.0 - 1.0;
            vec3 ty = texture(terrainNormal, vec3(vTerrainPos.xz * s, 3.0)).xyz * 2.0 - 1.0;
            vec3 tz = texture(terrainNormal, vec3(vTerrainPos.xy * s, 3.0)).xyz * 2.0 - 1.0;
            float ns = terrainNormalScale[3];
            tx.xy *= ns; ty.xy *= ns; tz.xy *= ns;
            vec3 nX = vec3(n.x * tx.z, tx.y + n.y, tx.x + n.z);
            vec3 nY = vec3(ty.x + n.x, n.y * ty.z, -ty.y + n.z);
            vec3 nZ = vec3(tz.x + n.x, tz.y + n.y, n.z * tz.z);
            nX.x = abs(nX.x) * sign(n.x);
            nY.y = abs(nY.y) * sign(n.y);
            nZ.z = abs(nZ.z) * sign(n.z);
            vec3 tri = nX * tw3.x + nY * tw3.y + nZ * tw3.z;
            wn += tri * (tw.w * inversesqrt(max(dot(tri, tri), 1e-8)));
        }
        normal = normalize((viewMatrix * vec4(normalize(wn + n * 1e-3), 0.0)).xyz);
    }
${hooks.normal ? `    {\n${hooks.normal}\n    }\n` : ''}`)
            if (hooks.color) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    {
${hooks.color}
    }
`)
        },
        computeCacheKey: () => 'terrain-splat-1' + (hookKey ? '-' + hookKey.toString(36) : ''),
        // Only the terrain's own PhysicalMaterial: passes that render the object with a ShaderMaterial of their own
        // (G-buffer, depth) would get the varyings without the vertex code that writes them.
        isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
    }
    m.registerMaterialExtensions([ext])
    m.userData.terrainUniforms = uniforms
    return m
}

export interface Terrain {
    mesh: Mesh
    sides?: Mesh
    material: PhysicalMaterial
    height: (x: number, z: number) => number
    size: number
    minY: number
    maxY: number
    /** Surface normal at a point (from the height function). */
    normalAt: (x: number, z: number, target?: Vector3) => Vector3
    /** An erosion mask at a point, 0..1 (0 without erosion). */
    mask: (name: keyof ErosionMasks, x: number, z: number) => number
}

const built = new WeakMap<ThreeViewer, Terrain[]>()
/** The terrains built in a viewer, in build order (a style preset can rebuild the ground from them). */
export function builtTerrains(viewer: ThreeViewer): Terrain[] {
    return built.get(viewer) ?? []
}

/** Builds the terrain mesh, its splat attributes and, with `base`, cut-away diorama sides. */
export async function buildTerrain(viewer: ThreeViewer, o: TerrainOptions): Promise<Terrain> {
    const {size, res, height} = o
    const half = size / 2
    const step = size / res
    const n1 = res + 1
    const count = n1 * n1
    const pos = new Float32Array(count * 3)
    const nor = new Float32Array(count * 3)
    const uv = new Float32Array(count * 2)
    const splat = new Float32Array(count * 4)
    const col = new Float32Array(count * 3)
    const hs = new Float32Array(count)
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) hs[j * n1 + i] = height(-half + i * step, -half + j * step)
    const masks = o.erosion ? erode(hs, n1, step, o.erosion) : undefined
    // bilinear lookup in a grid (heights or masks), clamped to the tile
    const lerpGrid = (a: Float32Array, x: number, z: number) => {
        const fx = Math.min(res - 1e-6, Math.max(0, (x + half) / step)), fz = Math.min(res - 1e-6, Math.max(0, (z + half) / step))
        const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * n1 + i
        return (a[k] * (1 - u) + a[k + 1] * u) * (1 - v) + (a[k + n1] * (1 - u) + a[k + n1 + 1] * u) * v
    }
    const surface = masks ? (x: number, z: number) => lerpGrid(hs, x, z) : height
    let minY = Infinity, maxY = -Infinity
    const n = new Vector3()
    const w = [0, 0, 0, 0], tint = [1, 1, 1]
    const sample: TerrainSample = {x: 0, z: 0, h: 0, slope: 0, n, flow: 0, deposit: 0, eroded: 0, talus: 0}
    const hAt = (i: number, j: number) => hs[Math.min(res, Math.max(0, j)) * n1 + Math.min(res, Math.max(0, i))]
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
        const k = j * n1 + i
        const x = -half + i * step, z = -half + j * step, h = hs[k]
        minY = Math.min(minY, h)
        maxY = Math.max(maxY, h)
        pos.set([x, h, z], k * 3)
        if (o.mesh) continue // the mesh is built (and painted) in warpedMesh
        n.set(hAt(i - 1, j) - hAt(i + 1, j), 2 * step, hAt(i, j - 1) - hAt(i, j + 1)).normalize()
        nor.set([n.x, n.y, n.z], k * 3)
        uv.set([i / res, 1 - j / res], k * 2)
        sample.x = x; sample.z = z; sample.h = h; sample.slope = 1 - n.y
        if (masks) {
            sample.flow = masks.flow[k]; sample.deposit = masks.deposit[k]; sample.eroded = masks.eroded[k]; sample.talus = masks.talus[k]
        }
        w.fill(0)
        w[0] = 1
        tint[0] = tint[1] = tint[2] = 1
        o.paint(sample, w, tint)
        splat.set(w, k * 4)
        col.set(tint.map(c => Math.max(0, c)), k * 3)
    }
    const index = new Uint32Array(res * res * 6)
    let p = 0
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1
        index.set([a, c, b, b, c, d], p)
        p += 6
    }
    let g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('normal', new BufferAttribute(nor, 3))
    g.setAttribute('uv', new BufferAttribute(uv, 2))
    g.setAttribute('splat', new BufferAttribute(splat, 4))
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.setIndex(new BufferAttribute(index, 1))
    if (o.mesh) g = warpedMesh(o, surface, masks ? (name, x, z) => lerpGrid(masks[name], x, z) : undefined, step)
    g.computeBoundingBox()
    g.computeBoundingSphere()

    const textures = await loadTerrainLayers(o.layers, o.textureRes)
    const material = terrainMaterial(o.layers, textures, o.shader)
    const mesh = new Mesh(g, material)
    mesh.name = 'Terrain'
    mesh.castShadow = true
    mesh.receiveShadow = true
    viewer.scene.addObject(mesh)

    let sides: Mesh | undefined
    if (o.base) sides = await buildSides(viewer, o, hs, minY - o.base)

    const normalAt = (x: number, z: number, target = new Vector3()) => {
        const e = step * (masks ? 1 : 0.5)
        return target.set(surface(x - e, z) - surface(x + e, z), 2 * e, surface(x, z - e) - surface(x, z + e)).normalize()
    }
    const mask = (name: keyof ErosionMasks, x: number, z: number) => masks ? lerpGrid(masks[name], x, z) : 0
    const terrain: Terrain = {mesh, sides, material, height: surface, size, minY, maxY, normalAt, mask}
    built.set(viewer, [...builtTerrains(viewer), terrain])
    return terrain
}

/** The non-uniform mesh of {@link TerrainOptions.mesh}: heights, masks and paint sampled from the grid. */
function warpedMesh(o: TerrainOptions, surface: (x: number, z: number) => number,
    mask: ((name: keyof ErosionMasks, x: number, z: number) => number) | undefined, gridStep: number) {
    const {res} = o.mesh!
    const half = o.size / 2
    const fx = o.mesh!.x, fz = o.mesh!.z ?? fx
    const n1 = res + 1, count = n1 * n1
    const X = new Float64Array(n1), Z = new Float64Array(n1)
    for (let i = 0; i < n1; i++) {
        X[i] = Math.min(half, Math.max(-half, fx(i / res)))
        Z[i] = Math.min(half, Math.max(-half, fz(i / res)))
    }
    const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2)
    const splat = new Float32Array(count * 4), col = new Float32Array(count * 3)
    const n = new Vector3(), w = [0, 0, 0, 0], tint = [1, 1, 1]
    const sample: TerrainSample = {x: 0, z: 0, h: 0, slope: 0, n, flow: 0, deposit: 0, eroded: 0, talus: 0}
    const e = gridStep
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
        const k = j * n1 + i, x = X[i], z = Z[j]
        const h0 = surface(x, z)
        n.set(surface(x - e, z) - surface(x + e, z), 2 * e, surface(x, z - e) - surface(x, z + e)).normalize()
        const slope = 1 - n.y
        pos[k * 3] = x
        pos[k * 3 + 1] = h0 + (o.relief ? o.relief(x, z, h0, slope) : 0)
        pos[k * 3 + 2] = z
        uv[k * 2] = (x + half) / o.size
        uv[k * 2 + 1] = 1 - (z + half) / o.size
        sample.x = x; sample.z = z; sample.h = h0; sample.slope = slope
        if (mask) {
            sample.flow = mask('flow', x, z); sample.deposit = mask('deposit', x, z); sample.eroded = mask('eroded', x, z); sample.talus = mask('talus', x, z)
        }
        w.fill(0)
        w[0] = 1
        tint[0] = tint[1] = tint[2] = 1
        o.paint(sample, w, tint)
        splat.set(w, k * 4)
        col[k * 3] = Math.max(0, tint[0]); col[k * 3 + 1] = Math.max(0, tint[1]); col[k * 3 + 2] = Math.max(0, tint[2])
    }
    const index = new Uint32Array(res * res * 6)
    let p = 0
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
        const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1
        index.set([a, c, b, b, c, d], p)
        p += 6
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('uv', new BufferAttribute(uv, 2))
    g.setAttribute('splat', new BufferAttribute(splat, 4))
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.setIndex(new BufferAttribute(index, 1))
    g.computeVertexNormals()
    return g
}

/** A mesh coordinate map for {@link TerrainOptions.mesh}: spacing `fine` (m) between `a` and `b`, growing smoothly
 * to fill the rest of -half..half with `res` segments in all. Returns the map, or the uniform one if it cannot fit. */
export function focusAxis(half: number, res: number, a: number, b: number, fine: number) {
    const nFine = Math.min(res - 8, Math.round((b - a) / fine))
    const left = a + half, right = half - b
    const nRest = res - nFine
    const nl = Math.max(4, Math.round(nRest * left / Math.max(1e-6, left + right))), nr = Math.max(4, nRest - nl)
    if (nFine < 1 || nl + nr + nFine !== res) return (t: number) => -half + 2 * half * t
    // the outer parts: cell size grows geometrically from `fine` so the step is continuous at the edges of the focus
    const ramp = (len: number, cells: number) => {
        // find q with fine * (q^cells - 1) / (q - 1) = len
        if (fine * cells >= len) return (k: number) => len * k / cells
        let lo = 1.0000001, hi = 2
        for (let i = 0; i < 60; i++) {
            const q = (lo + hi) / 2
            if (fine * (Math.pow(q, cells) - 1) / (q - 1) > len) hi = q
            else lo = q
        }
        const q = (lo + hi) / 2
        return (k: number) => fine * (Math.pow(q, k) - 1) / (q - 1)
    }
    const rl = ramp(left, nl), rr = ramp(right, nr)
    return (t: number) => {
        const k = t * res
        if (k <= nl) return a - rl(nl - k)
        if (k <= nl + nFine) return a + (b - a) * (k - nl) / nFine
        return b + rr(k - nl - nFine)
    }
}

/** Diorama sides: a wall under each edge from the surface down to the base, and a bottom. */
async function buildSides(viewer: ThreeViewer, o: TerrainOptions, hs: Float32Array, bottom: number) {
    const {size, res} = o
    const half = size / 2, step = size / res, n1 = res + 1
    const layer = o.sideLayer ?? {id: 'brown_mud_02', tile: 2}
    const verts: number[] = [], uvs: number[] = [], nors: number[] = [], idx: number[] = []
    const edge = (get: (t: number) => [number, number, number], normal: [number, number, number]) => {
        const start = verts.length / 3
        for (let t = 0; t <= res; t++) {
            const [x, y, z] = get(t)
            const s = t * step
            verts.push(x, y, z, x, bottom, z)
            uvs.push(s / layer.tile, y / layer.tile, s / layer.tile, bottom / layer.tile)
            nors.push(...normal, ...normal)
        }
        // Wind the triangles so they face along `normal` (front faces outward, single-sided): the G-buffer normal
        // of a back face points into the terrain, and SSGI then reads the sides as fully occluded.
        const p0 = new Vector3(verts[start * 3], verts[start * 3 + 1], verts[start * 3 + 2])
        const p1 = new Vector3(verts[start * 3 + 3], verts[start * 3 + 4], verts[start * 3 + 5])
        const p2 = new Vector3(verts[start * 3 + 6], verts[start * 3 + 7], verts[start * 3 + 8])
        const face = p1.clone().sub(p0).cross(p2.clone().sub(p0))
        const flip = face.dot(new Vector3(...normal)) < 0
        for (let t = 0; t < res; t++) {
            const a = start + t * 2, b = a + 1, c = a + 2, d = a + 3
            if (flip) idx.push(a, c, b, c, d, b)
            else idx.push(a, b, c, c, b, d)
        }
    }
    const H = (i: number, j: number) => hs[j * n1 + i]
    edge(t => [-half + t * step, H(t, res), half], [0, 0, 1]) // +z
    edge(t => [half - t * step, H(res - t, 0), -half], [0, 0, -1]) // -z
    edge(t => [half, H(res, t), -half + t * step], [1, 0, 0]) // +x
    edge(t => [-half, H(0, res - t), half - t * step], [-1, 0, 0]) // -x
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3))
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nors), 3))
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
    g.setIndex(idx)
    const mat = new PhysicalMaterial({color: new Color(...layer.tint ?? [1, 1, 1]), roughness: 1})
    const base = `${PH_TEX}/1k/${layer.id}/${layer.id}`
    const load = async(s: string, srgb: boolean) => {
        const t = await viewer.load<any>(asset(`${base}_${s}_1k.jpg`)).catch(() => undefined)
        if (!t) return undefined
        t.wrapS = t.wrapT = RepeatWrapping
        t.colorSpace = srgb ? SRGBColorSpace : LinearSRGBColorSpace
        t.needsUpdate = true
        return t
    }
    const [map, nmap, rmap] = await Promise.all([load('diff', true), load('nor_gl', false), load('rough', false)])
    if (map) mat.map = map
    if (nmap) mat.normalMap = nmap
    if (rmap) mat.roughnessMap = rmap
    mat.name = 'Diorama sides'
    const mesh = new Mesh(g, mat)
    mesh.name = 'Diorama sides'
    mesh.castShadow = true
    mesh.receiveShadow = true
    viewer.scene.addObject(mesh)
    return mesh
}

/** Sum of weights helper for paint rules: sets layer i to v and scales the others by (1 - v). */
export function blendLayer(w: number[], i: number, v: number) {
    v = clamp01(v)
    for (let k = 0; k < w.length; k++) w[k] *= 1 - v
    w[i] += v
}
