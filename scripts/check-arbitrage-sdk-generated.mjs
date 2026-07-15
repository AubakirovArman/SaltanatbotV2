/** Verify checked-in arbitrage SDK runtime artifacts match canonical TypeScript. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageDir = join(root, "packages", "arbitrage-sdk");
const outputDir = mkdtempSync(join(tmpdir(), "saltanat-arbitrage-sdk-"));
const tsc = join(root, "node_modules", ".bin", "tsc");
const sources = [
  "index",
  "basisClock",
  "basisCoverage",
  "client",
  "clockHealth",
  "continuousFeedHealth",
  "continuousMarketEconomics",
  "continuousMarketEconomicsMetadata",
  "continuousMarketEconomicsQuantity",
  "continuousMarketEconomicsStrategy",
  "continuousMarketEconomicsTypes",
  "continuousRoutes",
  "fundingCurve",
  "fundingCurveTypes",
  "lifecycle",
  "nLeg",
  "nLegTypes",
  "nativeSpreads",
  "networkIdentity",
  "networkIdentityTypes",
  "opportunityEnvelope",
  "opportunityEnvelopeTypes",
  "optionsParity",
  "optionsParityTypes",
  "pairwise",
  "pairwiseRouteTypes",
  "publicMarketData",
  "registry",
  "triangularDepth",
  "triangularDepthTypes",
  "types",
  "validation"
];

try {
  execFileSync(tsc, [...sources.map((source) => join(packageDir, `${source}.ts`)), "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--declaration", "--outDir", outputDir]);
  const stale = sources.flatMap((source) => [`${source}.js`, `${source}.d.ts`]).filter((file) => readFileSync(join(packageDir, file), "utf8") !== readFileSync(join(outputDir, file), "utf8"));
  if (stale.length > 0) {
    console.error(`Generated arbitrage SDK artifacts are stale: ${stale.join(", ")}. Run npm run build -w @saltanatbotv2/arbitrage-sdk.`);
    process.exitCode = 1;
  } else {
    console.log("Arbitrage SDK runtime and declarations are current.");
  }
} finally {
  rmSync(outputDir, { force: true, recursive: true });
}
