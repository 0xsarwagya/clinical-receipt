import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    verify: "src/verify.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
