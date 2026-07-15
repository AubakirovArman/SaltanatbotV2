import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = [
  ...new Set(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
      { cwd: root, encoding: "utf8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean)
  )
].sort();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
const failures = [];

for (const relativeFile of markdownFiles) {
  const absoluteFile = resolve(root, relativeFile);
  const source = readFileSync(absoluteFile, "utf8");

  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^(?:https?:|mailto:|data:)/i.test(raw)) continue;
    const path = decodeURIComponent(raw.split("#", 1)[0].split("?", 1)[0]);
    const target = path.startsWith("/") ? resolve(root, `.${path}`) : resolve(dirname(absoluteFile), path);
    if (!existsSync(target)) failures.push(`${relativeFile}: missing local link target ${raw}`);
  }

  for (const match of source.matchAll(/\bnpm run ([a-zA-Z0-9:_-]+)/g)) {
    const command = match[1];
    if (!scripts.has(command)) failures.push(`${relativeFile}: documents unknown root npm script "${command}"`);
  }
}

if (failures.length) {
  console.error(`Documentation checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Documentation checks passed for ${markdownFiles.length} tracked and untracked non-ignored Markdown files.`);
