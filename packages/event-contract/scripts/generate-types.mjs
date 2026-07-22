import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const schemaPath = fileURLToPath(
  new URL("../schema/event-batch.schema.json", import.meta.url),
);
const outputPath = fileURLToPath(
  new URL("../src/generated/event-batch.ts", import.meta.url),
);

const generated = await compileFromFile(schemaPath, {
  bannerComment:
    "/* AUTO-GENERATED from schema/event-batch.schema.json. Do not edit directly. */",
  style: {
    singleQuote: false,
    semi: true,
    trailingComma: "all",
  },
});

if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("Generated event types are stale. Run: pnpm contract:generate");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, generated, "utf8");
  console.log("Generated packages/event-contract/src/generated/event-batch.ts");
}
