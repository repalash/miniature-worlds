import type {ThreeViewer} from 'threepipe'
import type {LightingRig} from './kit/lighting'

/** What a tile's `setup` gets: the viewer (all plugins added) and the sun rig. */
export interface TileContext {viewer: ThreeViewer, rig: LightingRig}

/** What a tile's `setup` returns. Every field is optional. */
export interface TileResult {
    /** Per-frame animation of objects and lights; t in seconds. */
    animate?: (t: number) => void
    /** A camera path; t in seconds (the "Camera path" checkbox plays it). */
    camera?: (t: number) => void
    /** Asset credits, shown in the corner of the page. */
    credits?: string
    /** Named camera views; the first is the start view. `?view=<name>` picks one on load. */
    views?: Record<string, () => void>
    /** Named lighting presets (times of day); the first is the start one. `?time=<name>` picks one on load. */
    times?: Record<string, () => void | Promise<void>>
}

/** A miniature world tile: a label for the menu and an async setup that builds it into the viewer's scene. */
export interface Tile {
    label: string
    setup: (ctx: TileContext) => Promise<TileResult | void>
}
