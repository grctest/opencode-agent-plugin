import { mkdirSync, existsSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const DASHBOARD_DIST = join(DIST, "dashboard");

const WATCH = process.argv.includes("--watch");

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
    esbuild: true,
    options: {
      entryPoints: ["src/index.js"],
      bundle: true,
      format: "esm",
      platform: "node",
      sourcemap: true,
      outfile: join(DIST, "loom.js"),
      external: [
        "@opencode-ai/plugin",
        "@opencode-ai/sdk",
        "bun:sqlite",
        "onnxruntime-node",
        "@huggingface/tokenizers",
      ],
    },
  },
  {
    name: "Dashboard server (dist/dashboard/server.js)",
    esbuild: true,
    options: {
      entryPoints: ["src/dashboard/server.js"],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile: join(DASHBOARD_DIST, "server.js"),
      external: ["bun:sqlite", "onnxruntime-node", "@huggingface/tokenizers"],
    },
  },
  {
    name: "Dashboard app (dist/dashboard/app.js)",
    esbuild: true,
    options: {
      entryPoints: ["src/dashboard/app.jsx"],
      bundle: true,
      format: "esm",
      minify: true,
      sourcemap: true,
      outfile: join(DASHBOARD_DIST, "app.js"),
      jsx: "automatic",
      jsxImportSource: "react",
    },
  },
  {
    name: "Dashboard styles (dist/dashboard/styles.css + pure.css)",
    esbuild: false,
    run: () => {
      copyStyles();
      copyPureCSS();
      return true;
    },
  },
];

let failed = false;

if (WATCH) {
  const contexts = [];
  for (const { name, esbuild: isEsbuild, options } of steps) {
    console.log(`\n👀 ${name} (watch)...`);
    try {
      if (isEsbuild) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
        contexts.push(ctx);
      }
    } catch (err) {
      console.error(`\n❌ ${name} failed:`, err.message || err);
      failed = true;
      break;
    }
  }

  if (!failed) {
    watch(join(ROOT, "src/dashboard/app.css"), () => {
      console.log("\n📦 Dashboard styles updated...");
      copyStyles();
    });
    watch(join(ROOT, "node_modules/purecss/build"), () => {
      console.log("\n📦 Pure.css updated...");
      copyPureCSS();
    });
    console.log("\n✅ Watching for changes (Ctrl+C to stop)");
    setInterval(() => {}, 1 << 30);
  }
} else {
  for (const { name, esbuild: isEsbuild, options, run: step } of steps) {
    console.log(`\n📦 ${name}...`);
    try {
      if (isEsbuild) {
        await esbuild.build(options);
      } else {
        await step();
      }
    } catch (err) {
      console.error(`\n❌ ${name} failed:`, err.message || err);
      failed = true;
      break;
    }
  }
}

if (failed) {
  console.error("\n❌ Build failed");
  process.exit(1);
}

if (!WATCH) {
  console.log("\n✅ Build complete");
}
