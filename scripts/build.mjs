import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const DASHBOARD_DIST = join(DIST, "dashboard");

mkdirSync(DASHBOARD_DIST, { recursive: true });

function copyStyles() {
  const css = readFileSync(join(ROOT, "src/dashboard/app.css"), "utf-8");
  writeFileSync(join(DASHBOARD_DIST, "styles.css"), css);
  return true;
}

function copyPureCSS() {
  const pureCss = readFileSync(
    join(ROOT, "node_modules/purecss/build/pure-min.css"),
    "utf-8"
  );
  writeFileSync(join(DASHBOARD_DIST, "pure.css"), pureCss);
  const responsiveCss = readFileSync(
    join(ROOT, "node_modules/purecss/build/grids-responsive-min.css"),
    "utf-8"
  );
  writeFileSync(join(DASHBOARD_DIST, "pure-grids-responsive.css"), responsiveCss);
  return true;
}

const steps = [
  {
    name: "Main plugin (dist/loom.js)",
    run: () =>
      esbuild.build({
        entryPoints: ["src/index.js"],
        bundle: true,
        format: "esm",
        platform: "node",
        outfile: join(DIST, "loom.js"),
        external: [
          "@opencode-ai/plugin",
          "@opencode-ai/sdk",
          "bun:sqlite",
        ],
      }),
  },
  {
    name: "Dashboard server (dist/dashboard/server.js)",
    run: () =>
      esbuild.build({
        entryPoints: ["src/dashboard/server.js"],
        bundle: true,
        format: "esm",
        platform: "node",
        outfile: join(DASHBOARD_DIST, "server.js"),
        external: ["bun:sqlite"],
      }),
  },
  {
    name: "Dashboard app (dist/dashboard/app.js)",
    run: () =>
      esbuild.build({
        entryPoints: ["src/dashboard/app.jsx"],
        bundle: true,
        format: "esm",
        minify: true,
        outfile: join(DASHBOARD_DIST, "app.js"),
        jsx: "automatic",
        jsxImportSource: "react",
      }),
  },
  {
    name: "Dashboard styles (dist/dashboard/styles.css + pure.css)",
    run: () => {
      copyStyles();
      copyPureCSS();
      return true;
    },
  },
];

let failed = false;

for (const { name, run: step } of steps) {
  console.log(`\n📦 ${name}...`);
  try {
    await step();
  } catch {
    failed = true;
    break;
  }
}

if (failed) {
  console.error("\n❌ Build failed");
  process.exit(1);
}

console.log("\n✅ Build complete");
