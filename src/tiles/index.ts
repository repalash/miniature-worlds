import type {Tile} from '../types'
import {alpine} from './alpine'

/** The tiles of this project, by id. `?tile=<id>` opens one; the first is the default. Add new tiles here. */
export const tiles: Record<string, Tile> = {
    alpine,
}
