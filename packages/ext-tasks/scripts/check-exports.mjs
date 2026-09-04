import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const expectedExports = new Set([
  "./core",
  "./core/v1",
  "./core/v2",
  "./client",
  "./server",
]);
const actualExports = new Set(Object.keys(manifest.exports ?? {}));

if (actualExports.has(".")) {
  throw new Error("The package must not expose a root entry point.");
}

for (const subpath of expectedExports) {
  if (!actualExports.delete(subpath)) {
    throw new Error(`Missing package export: ${subpath}`);
  }

  const conditions = manifest.exports[subpath];
  await access(new URL(conditions.import, `file://${packageDirectory}/`));
  await access(new URL(conditions.types, `file://${packageDirectory}/`));
}

if (actualExports.size > 0) {
  throw new Error(
    `Unexpected package exports: ${[...actualExports].sort().join(", ")}`,
  );
}
