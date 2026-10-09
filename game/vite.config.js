import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径 base：打包产物（js/css/图片等）全部按相对路径引用，可部署到任意子路径下正常加载
  base: './',
  server: { host: true, port: 5180, strictPort: true, open: false },
  // D9：构建产物启用 esbuild 压缩混淆（源码保持可读，构建时混淆验证逻辑与串）。
  build: { minify: 'esbuild' },
});
