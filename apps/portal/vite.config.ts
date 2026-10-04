import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
export default defineConfig({ plugins: [preact()], base: '/portal/', build: { outDir: 'dist', target: 'es2022' } });
