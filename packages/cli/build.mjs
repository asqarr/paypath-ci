import { build } from "esbuild";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(packageDirectory, "package.json");
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const outputPath = resolve(packageDirectory, "dist/paypath.js");

await mkdir(dirname(outputPath), { recursive: true });
await build({
  entryPoints: [resolve(packageDirectory, "src/index.ts")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@supabase/supabase-js", "dotenv", "stripe", "zod"],
  legalComments: "none",
});

if (typeof packageJson.version !== "string") {
  throw new Error("The CLI package.json must contain a string version.");
}
