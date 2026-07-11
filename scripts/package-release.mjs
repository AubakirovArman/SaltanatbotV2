import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const channel = args.channel ?? "nightly";
const version = args.version ?? defaultVersion(channel);
validate(channel, version);

const commit = git(["rev-parse", "HEAD"]);
const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH ?? git(["show", "-s", "--format=%ct", "HEAD"]));
const name = `saltanatbotv2-${version}`;
const dirty = git(["status", "--porcelain"]).length > 0;
const metadata = { name, version, channel, commit, sourceDateEpoch, node: process.version, dirty };

if (args["print-metadata"]) {
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
  process.exit(0);
}

if (dirty && process.env.ALLOW_DIRTY_RELEASE !== "1") {
  throw new Error("Refusing to package a dirty worktree; commit the release source or set ALLOW_DIRTY_RELEASE=1 for a local-only archive.");
}

for (const required of ["backend/dist/server.js", "frontend/dist/index.html"]) {
  try {
    readFileSync(path.join(root, required));
  } catch {
    throw new Error(`Missing ${required}; run npm run build before packaging.`);
  }
}

const releaseDir = path.join(root, "release");
const stagingRoot = path.join(root, ".release-staging");
const staging = path.join(stagingRoot, name);
rmSync(releaseDir, { recursive: true, force: true });
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
mkdirSync(staging, { recursive: true });

copyFiles(["package.json", "package-lock.json", "README.md", "README.ru.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "SUPPORT.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "Dockerfile", "docker-compose.yml"]);
copyTree("docs");
copyTree("packages");
copyFiles(["backend/package.json", "frontend/package.json"]);
copyTree("backend/dist");
copyTree("frontend/dist");

writeFileSync(path.join(staging, "release-info.json"), `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(path.join(releaseDir, `${name}.release-info.json`), `${JSON.stringify(metadata, null, 2)}\n`);

const archive = path.join(releaseDir, `${name}.tar.gz`);
execFileSync("tar", [
  "--sort=name",
  `--mtime=@${sourceDateEpoch}`,
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "-I",
  "gzip -n -9",
  "-cf",
  archive,
  "-C",
  stagingRoot,
  name
]);
console.log(`Packaged ${path.relative(root, archive)} (${channel}, ${commit.slice(0, 12)}).`);

function copyFiles(files) {
  for (const relative of files) {
    const destination = path.join(staging, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(root, relative), destination);
  }
}

function copyTree(relative) {
  cpSync(path.join(root, relative), path.join(staging, relative), {
    recursive: true,
    filter: (source) => !/(?:^|\/)(?:node_modules|data|dist)(?:\/|$)/.test(path.relative(path.join(root, relative), source)) || source === path.join(root, relative, "dist")
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    if (key === "print-metadata") parsed[key] = true;
    else parsed[key] = values[++index];
  }
  return parsed;
}

function validate(releaseChannel, releaseVersion) {
  if (!["nightly", "alpha", "beta", "stable"].includes(releaseChannel)) throw new Error(`Unsupported release channel: ${releaseChannel}`);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/.test(releaseVersion)) throw new Error(`Unsafe release version: ${releaseVersion}`);
  if (releaseChannel === "stable" && !/^v?\d+\.\d+\.\d+$/.test(releaseVersion)) throw new Error("Stable releases require vMAJOR.MINOR.PATCH.");
  if (releaseChannel === "alpha" && !/-alpha\.\d+$/.test(releaseVersion)) throw new Error("Alpha releases require a -alpha.N suffix.");
  if (releaseChannel === "beta" && !/-(?:beta|rc)\.\d+$/.test(releaseVersion)) throw new Error("Beta releases require a -beta.N or -rc.N suffix.");
}

function defaultVersion(releaseChannel) {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${releaseChannel}-${date}-${git(["rev-parse", "--short=8", "HEAD"])}`;
}

function git(command) {
  return execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
}
