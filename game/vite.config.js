import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, strictPort: true, open: false },
  // D9：构建产物启用 esbuild 压缩混淆（源码保持可读，构建时混淆验证逻辑与串）。
  build: { minify: 'esbuild' },
});
