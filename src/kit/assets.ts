import {getUrlQueryParam} from 'threepipe'

/**
 * Where the kit loads its remote files from.
 *
 * - Poly Haven files (CC0: HDRI skies, ground and prop textures) are fetched from a copy on threepipe cloud, by file
 *   name, because the Poly Haven API terms ask applications to host their own copy. Point `POLY_HAVEN_COPY` at your
 *   own host for a product.
 * - Model files (`worldAsset(id)`): Poly Haven scans decimated and converted to GLB, hosted on threepipe cloud.
 * - `?assets=<base>` on the page URL loads every remote file from a local mirror laid out as `<base>/<host>/<path>`
 *   (offline work, tests).
 */
const POLY_HAVEN = 'https://dl.polyhaven.org/file/ph-assets/'
export const POLY_HAVEN_COPY = 'https://files.threepipe.org/p/ssgi-worlds/ph/'
export const WORLD_ASSETS = 'https://files.threepipe.org/p/ssgi-worlds/v1/'

const assetBase = getUrlQueryParam('assets')

/** The URL to load for a remote file (Poly Haven URLs map to the hosted copy). */
export function asset(url: string) {
    if (!assetBase) return url.startsWith(POLY_HAVEN) ? POLY_HAVEN_COPY + url.slice(url.lastIndexOf('/') + 1) : url
    const u = new URL(url)
    return assetBase.replace(/\/$/, '') + '/' + u.host + u.pathname
}

/** A hosted model file by id, e.g. `worldAsset('boulder_01')` (`loadTemplate` passes it through {@link asset}). */
export const worldAsset = (id: string) => `${WORLD_ASSETS}${id}.glb`
