import type {MaterialExtension, PhysicalMaterial} from 'threepipe'

/**
 * A cheaper terrain shader for tiles that fill the screen: the kit's terrain (terrain.ts) samples its triplanar
 * cliff layer (15 texture reads) at every pixel, also where that layer has no weight. This extension runs after the
 * terrain's own (lower priority) and wraps that block in a branch on the vertex weight, so meadows and snowfields
 * skip it; it also lowers the texture anisotropy. The look where cliffs are is unchanged.
 */
const CHEAP: MaterialExtension = {
    priority: -10,
    shaderExtender: (shader) => {
        const fs = shader.fragmentShader
        const start = fs.indexOf('// Layer 3 (cliffs): triplanar.')
        if (start < 0) { console.warn('terrainPatch: terrain shader changed, not applied'); return }
        const open = fs.lastIndexOf('{', start)
        shader.fragmentShader = fs.slice(0, open) + `tA[3] = vec4(0.5, 0.5, 0.5, 0.9); tN[3] = vec4(0.5, 0.5, 1.0, 0.0);
    if (vSplat.w > 0.002) ` + fs.slice(open)
    },
    computeCacheKey: () => 'terrain-cheap-1',
    isCompatible: (material) => (material as PhysicalMaterial).isPhysicalMaterial === true,
}

export function cheapTerrain(material: PhysicalMaterial, anisotropy = 4) {
    material.registerMaterialExtensions([CHEAP])
    const u = material.userData.terrainUniforms
    for (const k of ['terrainAlbedo', 'terrainNormal']) {
        const t = u?.[k]?.value
        if (t) { t.anisotropy = anisotropy; t.needsUpdate = true }
    }
}
