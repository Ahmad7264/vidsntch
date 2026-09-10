import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "api", "pot-provider");
const repo = "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git";
const version = "2.0.0";

function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, { cwd, stdio: "inherit", env });
}

async function main() {
  if (process.env.SKIP_YOUTUBE_POT === "1") {
    console.log("[VidSnatch] SKIP_YOUTUBE_POT=1; skipping YouTube POT provider preparation.");
    return;
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });

  console.log(`[VidSnatch] Preparing bgutil-ytdlp-pot-provider ${version}...`);
  run("git", ["clone", "--depth", "1", "--branch", version, repo, target], root);

  const server = path.join(target, "server");
  run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], server, {
    ...process.env,
    NODE_ENV: "development",
    NPM_CONFIG_PRODUCTION: "false",
    npm_config_production: "false",
  });

  // Use the project's root TypeScript installation explicitly. This avoids
  // Vercel/npx falling back to its built-in compiler when nested devDependencies
  // are omitted. --noCheck emits JavaScript without type-checking the provider's
  // CI-only helper scripts such as check_lockfiles.ts.
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) {
    throw new Error(`TypeScript compiler not found at ${tsc}`);
  }

  run("node", [
    tsc,
    "--noCheck",
    "--target", "ES2023",
    "--module", "Node16",
    "--moduleResolution", "Node16",
    "--rootDir", "src",
    "--outDir", "build",
    "--rewriteRelativeImportExtensions",
    "--esModuleInterop",
    "--skipLibCheck",
    "src/generate_once.ts",
  ], server, {
    ...process.env,
    NODE_ENV: "development",
    NPM_CONFIG_PRODUCTION: "false",
    npm_config_production: "false",
  });

  const generated = path.join(server, "build", "generate_once.js");
  if (!fs.existsSync(generated)) {
    throw new Error("bgutil generate_once.js was not produced.");
  }

  const plugin = path.join(target, "plugin");
  if (!fs.existsSync(plugin)) {
    throw new Error("bgutil yt-dlp plugin directory was not found.");
  }

  // The runtime needs only compiled JS, production dependencies, and the plugin.
  run("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], server, {
    ...process.env,
    NODE_ENV: "production",
    NPM_CONFIG_PRODUCTION: "true",
    npm_config_production: "true",
  });

  await fsp.rm(path.join(server, "src"), { recursive: true, force: true });
  await fsp.rm(path.join(server, "types"), { recursive: true, force: true });
  await fsp.rm(path.join(target, ".git"), { recursive: true, force: true });
  await fsp.rm(path.join(target, "README.md"), { force: true });
  await fsp.rm(path.join(target, "LICENSE"), { force: true });
  await fsp.rm(path.join(target, ".github"), { recursive: true, force: true });
  await fsp.rm(path.join(target, ".devcontainer"), { recursive: true, force: true });
  await fsp.rm(path.join(target, "install_plugin_dev.sh"), { force: true });
  await fsp.rm(path.join(server, "Dockerfile"), { force: true });
  await fsp.rm(path.join(server, "tsconfig.json"), { force: true });
  await fsp.rm(path.join(server, "package-lock.json"), { force: true });

  console.log(`[VidSnatch] bgutil POT provider ${version} prepared successfully.`);
  console.log(`[VidSnatch] Provider script: ${generated}`);
}

main().catch((error) => {
  console.error("[VidSnatch] Failed to prepare YouTube POT provider:", error);
  process.exit(1);
});
