// Bundles a *.test.ts with esbuild and runs it under node.
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require(path.join(__dirname, "../../node_modules/esbuild"));
const tests = process.argv.slice(2).length ? process.argv.slice(2) : ["disasm.test.ts", "alias.test.ts", "search.test.ts"];
let failed = false;
for (const t of tests) {
  const src = path.resolve(__dirname, t);
  const out = path.join(require("os").tmpdir(), "vv-" + path.basename(t, ".ts") + ".cjs");
  esbuild.buildSync({ entryPoints: [src], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "error",
    define: { "__dirname": JSON.stringify(__dirname) } });
  try { execFileSync(process.execPath, [out], { stdio: "inherit" }); } catch { failed = true; }
}
process.exit(failed ? 1 : 0);
