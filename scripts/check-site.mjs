import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = resolve(root, "site");
const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const htmlFiles = walk(siteRoot).filter((path) => extname(path) === ".html");
const expectedLanguages = new Map([
  [resolve(siteRoot, "index.html"), "en"],
  [resolve(siteRoot, "ru/index.html"), "ru"],
  [resolve(siteRoot, "kk/index.html"), "kk"],
]);

for (const htmlFile of htmlFiles) {
  const source = readFileSync(htmlFile, "utf8");
  const relative = htmlFile.slice(root.length + 1);
  const expectedLanguage = expectedLanguages.get(htmlFile);

  if (!expectedLanguage) failures.push(`${relative}: unexpected HTML entry point`);
  if (!new RegExp(`<html\\s+lang=["']${expectedLanguage}["']`).test(source)) {
    failures.push(`${relative}: expected html lang=${expectedLanguage}`);
  }
  if (!/<title>[^<]+<\/title>/.test(source)) failures.push(`${relative}: missing non-empty title`);
  if (!/<meta\s+name=["']viewport["']/.test(source)) failures.push(`${relative}: missing viewport metadata`);
  if (!/<main\s+id=["']content["']\s+tabindex=["']-1["']/.test(source)) {
    failures.push(`${relative}: missing focusable main#content landmark`);
  }
  if (!/<a\s+class=["']skip-link["']\s+href=["']#content["']/.test(source)) {
    failures.push(`${relative}: missing skip link`);
  }
  if (/\son[a-z]+\s*=/.test(source)) failures.push(`${relative}: inline event handler is not allowed`);

  for (const match of source.matchAll(/\s(?:href|src)=["']([^"']+)["']/g)) {
    const raw = match[1];
    if (/^(?:https?:|mailto:|data:|#)/i.test(raw)) continue;
    const localPath = decodeURIComponent(raw.split("#", 1)[0].split("?", 1)[0]);
    const target = resolve(dirname(htmlFile), localPath);
    if (!existsSync(target)) failures.push(`${relative}: missing local asset ${raw}`);
  }
}

for (const [requiredFile] of expectedLanguages) {
  if (!existsSync(requiredFile)) failures.push(`missing required page ${requiredFile.slice(root.length + 1)}`);
}

const css = readFileSync(resolve(siteRoot, "styles.css"), "utf8");
if (/@import\b/.test(css)) failures.push("site/styles.css: @import is not allowed");
if (!/:focus-visible/.test(css)) failures.push("site/styles.css: missing visible keyboard-focus style");
if (!/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css)) {
  failures.push("site/styles.css: missing reduced-motion support");
}

if (failures.length) {
  console.error(`Site checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Site checks passed for ${htmlFiles.length} localized HTML pages.`);
