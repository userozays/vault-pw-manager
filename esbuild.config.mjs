import esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const mode = process.argv[2] ?? "build";
const common = { bundle: true, target: "es2022", logLevel: "info", legalComments: "none" };

// Testler için çekirdek (şifreleme + depolama) Node'da çalışacak şekilde.
await esbuild.build({ ...common, entryPoints: ["src/core.ts"], outfile: "dist/core.mjs", format: "esm", platform: "neutral" });

if (mode === "desktop") {
  rmSync("dist/desktop", { recursive: true, force: true });
  mkdirSync("dist/desktop", { recursive: true });
  await esbuild.build({ ...common, entryPoints: ["src/desktop.ts"], outfile: "dist/desktop/renderer.js", format: "iife", platform: "browser", minify: true });
  for (const [from, to] of [["styles.css", "styles.css"], ["app/index.html", "index.html"], ["app/desktop.css", "desktop.css"]]) copyFileSync(from, `dist/desktop/${to}`);
} else if (mode === "core") {
  // yalnız çekirdek (testler)
} else if (mode === "preview") {
  mkdirSync("preview/out", { recursive: true });
  await esbuild.build({ ...common, entryPoints: ["preview/preview.ts"], outfile: "preview/out/preview.js", format: "iife", platform: "browser" });
  copyFileSync("styles.css", "preview/out/styles.css");
}
