import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    verify: "src/verify.ts",
    fhir: "src/fhir.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Emit each subpath as an independently loadable module. Consumers
  // who only import "@0xsarwagya/clinical-receipt" MUST NOT load
  // dist/fhir.js — the tests/bundle-size test enforces this boundary.
  splitting: false,
});
