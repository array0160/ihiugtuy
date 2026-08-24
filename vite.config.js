import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths let the same build work under
  // https://USER.github.io/REPO/
  base: "./",
  build: {
    target: "es2022",
  },
});
