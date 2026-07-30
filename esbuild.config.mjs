import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  banner: {
    js: "/* obsidian-ntfy-sync: generated bundle; source licensed AGPL-3.0-only */",
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
