import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";

const contracts = [
  {
    schema: "../schema/event-batch-v3.schema.json",
    output: "../src/generated/event-batch-v3.ts",
  },
];

for (const contract of contracts) {
  const schemaPath = fileURLToPath(new URL(contract.schema, import.meta.url));
  const outputPath = fileURLToPath(new URL(contract.output, import.meta.url));
  const generated = await compileFromFile(schemaPath, {
    bannerComment: `/* AUTO-GENERATED from ${contract.schema.replace("../", "")}. Do not edit directly. */`,
    style: {
      singleQuote: false,
      semi: true,
      trailingComma: "all",
    },
  });

  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== generated) {
      console.error(
        `Generated event types are stale for ${contract.schema}. Run: pnpm contract:generate`,
      );
      process.exitCode = 1;
    }
  } else {
    await writeFile(outputPath, generated, "utf8");
    console.log(`Generated ${contract.output.replace("../", "")}`);
  }
}
