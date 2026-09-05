import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const artifacts = [
  ["../schema/v1/schema.json", "17cdb3dbcc577ce6cca0781e4ecc0dca84cc2c67"],
  ["../schema/v1/schema.ts", "402150cd1e6b3369f10f897125f56ec5a1af0c9f"],
  ["../schema/v2/schema.json", "1d0ec255bbcc5744264be53bba0e09e7eb8a5615"],
  ["../schema/v2/schema.ts", "b6f6bffc1c19698d75a2ce3b69525ae0c3bfb8b8"],
];

function gitBlobId(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

for (const [path, expected] of artifacts) {
  const bytes = await readFile(new URL(path, import.meta.url));
  const actual = gitBlobId(bytes);
  if (actual !== expected) {
    throw new Error(
      `${path} provenance mismatch: expected ${expected}, received ${actual}`,
    );
  }
}

console.log("Schema provenance verified.");
