import {GBufferPlugin, ThreeViewer} from 'threepipe'

/**
 * The G-buffer material does not cut alpha-tested cards: three compiles USE_MAP only from a `map` property, which
 * the ShaderMaterial does not have, and refreshes the alphaTest uniform only for its built-in materials. The cards
 * were whole quads in the depth and normals, and SSGI lit them (pale ghost rectangles round the leaves). This fixes
 * the plugin's material instance at runtime, until threepipe does this itself.
 */
export function fixGBufferAlphaTest(viewer: ThreeViewer) {
    const gb = viewer.getPlugin(GBufferPlugin)?.material as any
    if (!gb || gb.userData.__alphaFix) return
    gb.userData.__alphaFix = true
    // A threepipe whose G-buffer material defines USE_MAP itself (the patch landed) needs no `map`: three would define
    // USE_MAP a second time and the program fails ("macro redefined").
    if (!Object.getOwnPropertyDescriptor(gb, 'map')?.get) Object.defineProperty(gb, 'map', {get() { return this.defines?.USE_MAP ? null : this.uniforms.map?.value ?? null }, configurable: true})
    const before = gb.onBeforeRender
    gb.onBeforeRender = function(...args: any[]) {
        before.apply(this, args)
        if (this.uniforms.alphaTest) this.uniforms.alphaTest.value = this.alphaTest
    }
}

