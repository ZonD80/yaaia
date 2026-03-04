// electron.vite.config.ts
import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
var __electron_vite_injected_dirname = "/Users/zond80/Documents/WORK_SITES/yaaia/yaaia-app";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/main",
      rollupOptions: {
        input: resolve(__electron_vite_injected_dirname, "electron/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist-electron/preload",
      rollupOptions: {
        input: resolve(__electron_vite_injected_dirname, "electron/preload/index.ts")
      }
    }
  },
  renderer: {
    root: "src",
    build: {
      outDir: "dist",
      rollupOptions: {
        input: resolve(__electron_vite_injected_dirname, "src/index.html")
      }
    },
    plugins: [vue()]
  }
});
export {
  electron_vite_config_default as default
};
