import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoots = ["apps", "packages", "spikes"];
const manifests = [];

for (const workspaceRoot of workspaceRoots) {
  const absoluteRoot = path.join(root, workspaceRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(absoluteRoot, entry.name, "package.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8").catch(() => "null"),
    );
    if (!manifest) continue;
    manifests.push({
      name: manifest.name,
      location: `${workspaceRoot}/${entry.name}`,
      dependencies: {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      },
    });
  }
}

const byName = new Map();
for (const manifest of manifests) {
  if (!manifest.name) throw new Error(`${manifest.location} has no package name`);
  if (byName.has(manifest.name)) throw new Error(`duplicate package: ${manifest.name}`);
  byName.set(manifest.name, manifest);
}

const graph = new Map();
for (const manifest of manifests) {
  const localDependencies = Object.keys(manifest.dependencies).filter((name) =>
    byName.has(name),
  );
  graph.set(manifest.name, localDependencies);

  for (const dependencyName of localDependencies) {
    const dependency = byName.get(dependencyName);
    if (
      manifest.location.startsWith("apps/") &&
      dependency.location.startsWith("apps/")
    ) {
      throw new Error(
        `${manifest.name} must not depend directly on application ${dependencyName}`,
      );
    }
    if (
      manifest.location.startsWith("packages/") &&
      dependency.location.startsWith("apps/")
    ) {
      throw new Error(
        `${manifest.name} must not depend on application ${dependencyName}`,
      );
    }
  }
}

const visiting = new Set();
const visited = new Set();

function visit(name, chain = []) {
  if (visiting.has(name)) {
    throw new Error(`workspace dependency cycle: ${[...chain, name].join(" -> ")}`);
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...chain, name]);
  visiting.delete(name);
  visited.add(name);
}

for (const name of graph.keys()) visit(name);

console.log(
  JSON.stringify({
    status: "passed",
    workspacePackages: manifests.length,
    dependencyCycles: 0,
    crossApplicationDependencies: 0,
  }),
);
