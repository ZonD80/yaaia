import { resolve } from "path";
import { createRequire } from "node:module";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";

const require = createRequire(import.meta.url);
const version = require("./package.json").version as string;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/main",
      rollupOptions: {
        input: resolve(__dirname, "electron/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/preload",
      rollupOptions: {
        input: resolve(__dirname, "electron/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: "src",
    define: { __APP_VERSION__: JSON.stringify(version) },
    build: {
      outDir: "dist",
      rollupOptions: {
        input: resolve(__dirname, "src/index.html"),
      },
    },
    plugins: [vue()],
  },
});
