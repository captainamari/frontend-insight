import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

const composeUrl = new URL(
  "../../../infra/compose/m0.compose.yml",
  import.meta.url,
);
const composeSource = await readFile(composeUrl, "utf8");
const document = parseDocument(composeSource);
const compose = document.toJS();

test("M0 Compose file is valid YAML with the expected isolated services", () => {
  assert.deepEqual(document.errors, []);
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    [
      "clickhouse",
      "kafka",
      "kafka-init",
      "mysql",
      "spike-app",
      "spike-consumer",
      "spike-runner",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(compose.volumes).sort(),
    ["clickhouse-data", "kafka-data", "mysql-data"].sort(),
  );
});

test("infrastructure images are pinned and no service is privileged", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    assert.notEqual(service.privileged, true, `${name} must not be privileged`);
    assert.equal(service.platform, undefined, `${name} must remain multi-arch`);
    if (name !== "kafka-init") {
      assert.notEqual(service.user, "0:0", `${name} must not run as root`);
    }
    if (service.image) {
      assert.doesNotMatch(service.image, /:latest$/, `${name} image must be pinned`);
    }
  }
  assert.equal(compose.services["kafka-init"].user, "0:0");
  assert.equal(
    compose.services.kafka.depends_on["kafka-init"].condition,
    "service_completed_successfully",
  );
});

test("only the local browser spike ports are published", () => {
  assert.equal(compose.services.mysql.ports, undefined);
  assert.equal(compose.services.clickhouse.ports, undefined);
  assert.equal(compose.services.kafka.ports, undefined);
  assert.equal(compose.services["spike-app"].ports.length, 2);
  for (const port of compose.services["spike-app"].ports) {
    assert.match(String(port), /^127\.0\.0\.1:/);
  }
});
