import {defineConfig} from 'vite'

export default defineConfig({
    // relative paths, so the build runs from any folder of a static host
    base: './',
    build: {
        target: 'es2022',
        // threepipe and the webgi plugins are one large chunk; that is expected
        chunkSizeWarningLimit: 8000,
    },
})
