import {BufferAttribute, BufferGeometry, Matrix4, mergeGeometries, Mesh, Object3D, PhysicalMaterial, ThreeViewer} from 'threepipe'

/**
 * Collects geometries per material and merges them, like the Batch in geo.ts, but each piece can carry a
 * colour (a vertex colour multiplied into the material's colour: one stone lighter than its neighbour, one plank
 * greyer). Pieces without a colour get white. Positions and normals only otherwise; procedural materials need no
 * UVs. Materials of pieces with colours get `vertexColors`.
 */
export class TintBatch {
    private readonly parts = new Map<PhysicalMaterial, BufferGeometry[]>()
    triangles = 0

    add(m: PhysicalMaterial, g: BufferGeometry, matrix?: Matrix4, color?: [number, number, number]) {
        if (matrix) g.applyMatrix4(matrix)
        for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k)
        if (!g.attributes.normal) g.computeVertexNormals()
        if (!g.index) {
            const n = g.attributes.position.count
            const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n)
            for (let i = 0; i < n; i++) idx[i] = i
            g.setIndex(new BufferAttribute(idx, 1))
        }
        const n = g.attributes.position.count
        const c = new Float32Array(n * 3)
        const [r, gg, b] = color ?? [1, 1, 1]
        for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b }
        g.setAttribute('color', new BufferAttribute(c, 3))
        let list = this.parts.get(m)
        if (!list) this.parts.set(m, list = [])
        list.push(g)
        return g
    }

    build(viewer: ThreeViewer, name: string, o: {castShadow?: boolean} = {}) {
        const group = new Object3D()
        group.name = name
        for (const [m, list] of this.parts) {
            const g = mergeGeometries(list, false)
            if (!g) { console.warn('batch: merge failed', name, m.name); continue }
            g.computeBoundingSphere()
            g.computeBoundingBox()
            this.triangles += (g.index ? g.index.count : g.attributes.position.count) / 3
            m.vertexColors = true
            const mesh = new Mesh(g, m)
            mesh.name = `${name}: ${m.name}`
            mesh.castShadow = o.castShadow ?? true
            mesh.receiveShadow = true
            group.add(mesh)
            list.forEach(c => c.dispose())
        }
        this.parts.clear()
        viewer.scene.addObject(group as any)
        return group
    }
}
