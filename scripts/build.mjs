import { mkdirSync, existsSync, readFileSync, writeFileSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import postcss from "postcss";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");
const DASHBOARD_DIST = join(DIST, "dashboard");

const WATCH = process.argv.includes("--watch");

mkdirSync(DASHBOARD_DIST, { recursive: true });

async function buildStyles() {
  const cssPath = join(ROOT, "src/styles/globals.css");
  const css = readFileSync(cssPath, "utf-8");
  const result = await postcss((await import("@tailwindcss/postcss")).default()).process(css, { from: cssPath, to: join(DASHBOARD_DIST, "styles.css") });
  for (const w of result.warnings()) console.warn("[postcss]", w.text);
  writeFileSync(join(DASHBOARD_DIST, "styles.css"), result.css);
  // cleanup legacy pure.css artifacts (no longer used after shadcn migration)
  for (const legacy of ["pure.css", "pure-grids-responsive.css"]) {
    try { const p = join(DASHBOARD_DIST, legacy); if (existsSync(p)) { const { unlinkSync } = await import("node:fs"); unlinkSync(p); console.log(`[build] removed legacy ${legacy}`); } } catch {}
  }
  const hasBgCard = result.css.includes("bg-card") || result.css.includes("bg-card");
  const hasFlex = result.css.includes(".flex");
  console.log(`[build] styles.css ${result.css.length} bytes, hasFlex=${hasFlex} hasBgCard=${hasBgCard} warnings=${result.warnings().length}`);
  if (!hasFlex) console.warn("[build] WARNING: Tailwind utilities missing — check @source in src/styles/globals.css");
  return true;
}

// esbuild alias plugin for @/* -> src/*
function aliasPlugin() {
  return {
    name: "alias",
    setup(build) {
      build.onResolve({ filter: /^@\/.*/ }, args => {
        let rel = args.path.slice(2); // strip @/
        // handle @/src/... -> should map to ROOT/src/... but rel already includes src/
        // so if rel starts with src/, join ROOT + rel directly, else join ROOT/src + rel
        const base = rel.startsWith("src/") ? join(ROOT, rel) : join(ROOT, "src", rel);
        // try extensionless and .tsx/.ts handling, also handle .js -> .tsx
        const tryPaths = [];
        if (base.endsWith(".js")) {
          const noExt = base.slice(0, -3);
          tryPaths.push(noExt + ".tsx", noExt + ".ts", base);
        } else {
          tryPaths.push(base + ".ts", base + ".tsx", base + ".js", base, base + ".jsx");
        }
        for (const c of tryPaths) {
          if (existsSync(c)) return { path: c };
        }
        // also try index
        for (const idx of [join(base, "index.ts"), join(base, "index.tsx")]) {
          if (existsSync(idx)) return { path: idx };
        }
        // fallback
        return { path: base };
      });
    },
  };
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
        "sqlite-vec",
        "zod",
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
      external: ["bun:sqlite", "sqlite-vec", "onnxruntime-node", "@huggingface/tokenizers"],
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
      plugins: [aliasPlugin()],
      loader: { ".ts": "tsx", ".tsx": "tsx" },
    },
  },
  {
    name: "Dashboard styles (dist/dashboard/styles.css)",
    esbuild: false,
    run: async () => {
      await buildStyles();
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
    watch(join(ROOT, "src/styles/globals.css"), async () => {
      console.log("\n📦 Dashboard styles updated...");
      await buildStyles();
    });
    watch(join(ROOT, "src/dashboard/app.css"), async () => {
      console.log("\n📦 Dashboard app.css updated...");
      await buildStyles();
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
