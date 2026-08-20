/**
 * Schema Generation Script using ts-to-zod as a library
 *
 * This script generates Zod schemas from schema.ts and performs necessary
 * post-processing for compatibility with this project.
 *
 * Follows the same pattern as ext-apps/scripts/generate-schemas.ts.
 *
 * ## Post-Processing Steps
 *
 * ### 1. Zod Import Path (`"zod"` → `"zod/v4"`)
 * ts-to-zod generates `import { z } from "zod"`. We rewrite to `import { z } from "zod/v4"`.
 *
 * ### 2. External Type References (`z.any()` → spec-owned stand-ins)
 * ts-to-zod cannot resolve types imported from the vendored spec.types.ts.
 * We replace z.any() placeholders with permissive stand-ins whose
 * `.meta({ id })` marks emit `$ref`s resolved by canonical spec splicing.
 * Generation fails on any unmapped placeholder.
 *
 * ### 3. Index Signatures (`z.record().and()` → `.passthrough()`)
 * TypeScript index signatures are translated to z.record().and(z.object({...})).
 * We replace with z.object({...}).passthrough() for compatibility.
 *
 * @see https://github.com/fabien0102/ts-to-zod
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "ts-to-zod";
import { toJSONSchema, globalRegistry, type $ZodType } from "zod/v4/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const SCHEMA_DIR = join(PROJECT_ROOT, "schema", "draft");
const SPEC_TYPES_FILE = join(SCHEMA_DIR, "schema.ts");
const GENERATED_DIR = join(SCHEMA_DIR, "generated");
const SCHEMA_OUTPUT_FILE = join(GENERATED_DIR, "schema.ts");
const JSON_SCHEMA_OUTPUT_FILE = join(SCHEMA_DIR, "schema.json");
const VENDORED_SPEC_SCHEMA_FILE = join(SCHEMA_DIR, "spec.schema.json");

/**
 * Definitions owned by the core specification. In the generated schema.json
 * these are emitted as `$ref: "#/$defs/<Name>"` and their definitions are
 * spliced verbatim (with their transitive `$ref` closure) from the vendored
 * canonical spec schema (spec.schema.json — see scripts/fetch-spec-schema.ts).
 *
 * This avoids re-deriving core-spec shapes through this repo's Zod pipeline:
 * corrections to the core spec's types flow into this artifact by re-running
 * `npm run fetch:spec-schema` + `npm run generate:schemas`.
 *
 * Maps generated/imported Zod schema export name -> canonical spec $defs name.
 */
const SPEC_OWNED_DEFS: Record<string, string> = {
  // Referenced by InputRequest/InputResponse unions in the canonical spec
  CreateMessageRequestSchema: "CreateMessageRequest",
  ListRootsRequestSchema: "ListRootsRequest",
  ElicitRequestSchema: "ElicitRequest",
  CreateMessageResultSchema: "CreateMessageResult",
  ListRootsResultSchema: "ListRootsResult",
  ElicitResultSchema: "ElicitResult",
  // MRTR types imported from spec.types.ts
  InputRequestSchema: "InputRequest",
  InputResponseSchema: "InputResponse",
  InputRequestsSchema: "InputRequests",
  InputResponsesSchema: "InputResponses",
  // The spec's bare JSON-RPC error object (imported as JSONRPCErrorObject)
  JSONRPCErrorObjectSchema: "Error",
  // JSON-RPC envelope and params types intersected by the extension's types
  JSONRPCRequestSchema: "JSONRPCRequest",
  JSONRPCNotificationSchema: "JSONRPCNotification",
  ResultSchema: "Result",
  NotificationParamsSchema: "NotificationParams",
};

/**
 * Runtime Zod stand-ins for spec-owned types referenced from schema.ts.
 *
 * ts-to-zod cannot resolve imported types, so it emits `z.any()` placeholders
 * for everything schema.ts imports from the vendored spec.types.ts. Each
 * placeholder is replaced with a permissive local schema carrying a
 * `.meta({ id })` mark: the mark makes every reference emit as
 * `$ref: "#/$defs/<Name>"`, and the canonical definition for each id is then
 * spliced verbatim from the vendored spec.schema.json (see SPEC_OWNED_DEFS).
 * The stand-ins' own shapes NEVER reach the published artifact — they exist
 * only so the generated module evaluates — so nothing here depends on any
 * SDK package, published or otherwise. The vendored spec is the sole source
 * of truth for these shapes.
 */
const LOCAL_SCHEMA_REPLACEMENTS: Record<string, string> = {
  InputRequestsSchema: `z.record(z.string(), z.unknown()).meta({ id: "InputRequests" })`,
  InputResponsesSchema: `z.record(z.string(), z.unknown()).meta({ id: "InputResponses" })`,
  JSONRPCErrorObjectSchema: `z.object({}).passthrough().meta({ id: "Error" })`,
  JSONRPCRequestSchema: `z.object({}).passthrough().meta({ id: "JSONRPCRequest" })`,
  JSONRPCNotificationSchema: `z.object({}).passthrough().meta({ id: "JSONRPCNotification" })`,
  ResultSchema: `z.object({}).passthrough().meta({ id: "Result" })`,
  NotificationParamsSchema: `z.object({}).passthrough().meta({ id: "NotificationParams" })`,
};

async function main() {
  const isCheck = process.argv.includes("--check");

  if (isCheck) {
    console.log("Checking schemas...");
  } else {
    console.log("🔧 Generating Zod schemas from schema.ts...\n");
  }

  const sourceText = readFileSync(SPEC_TYPES_FILE, "utf-8");

  const result = generate({
    sourceText,
    keepComments: true,
    skipParseJSDoc: false,
    getSchemaName: (typeName: string) => `${typeName}Schema`,
  });

  if (result.errors.length > 0) {
    console.error("❌ Generation errors:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  if (result.hasCircularDependencies) {
    console.warn("⚠️  Warning: Circular dependencies detected in types");
  }

  // Generate Zod schemas file
  const relativeImportPath = relative(GENERATED_DIR, SCHEMA_DIR).replace(
    /\\/g,
    "/"
  );
  let schemasContent = result.getZodSchemasFile(
    `${relativeImportPath}/schema.js`
  );
  schemasContent = postProcess(schemasContent);

  // Ensure generated directory exists. Required in both modes because check
  // mode writes a temp file here for dynamic import (its relative imports
  // resolve against this directory).
  mkdirSync(GENERATED_DIR, { recursive: true });

  if (isCheck) {
    // Check mode: only schema.json is tracked in git (generated/ is gitignored
    // as an intermediate artifact). We verify the committed schema.json matches
    // what would be regenerated from schema.ts.
    let hasChanges = false;

    // Write the freshly generated Zod schemas to disk so we can dynamic-import
    // them. This file is gitignored, so writing it is not a check concern.
    writeFileSync(SCHEMA_OUTPUT_FILE, schemasContent, "utf-8");
    const jsonSchemaContent = await generateJsonSchemaContent(SCHEMA_OUTPUT_FILE);

    if (existsSync(JSON_SCHEMA_OUTPUT_FILE)) {
      const existing = readFileSync(JSON_SCHEMA_OUTPUT_FILE, "utf-8");
      if (existing !== jsonSchemaContent) {
        console.error(
          "❌ JSON Schema is out of date. Run: npm run generate:schemas"
        );
        hasChanges = true;
      } else {
        console.log("  ✓ JSON Schema is up to date");
      }
    } else {
      console.error(
        "❌ JSON Schema file does not exist. Run: npm run generate:schemas"
      );
      hasChanges = true;
    }

    if (hasChanges) {
      process.exit(1);
    }
    console.log("\nAll schemas are up to date!");
    return;
  }

  // Write Zod schemas
  writeFileSync(SCHEMA_OUTPUT_FILE, schemasContent, "utf-8");
  console.log(`✅ Written: ${SCHEMA_OUTPUT_FILE}`);

  // Generate and write JSON Schema
  const jsonSchemaContent = await generateJsonSchemaContent(SCHEMA_OUTPUT_FILE);
  writeFileSync(JSON_SCHEMA_OUTPUT_FILE, jsonSchemaContent, "utf-8");
  console.log(`✅ Written: ${JSON_SCHEMA_OUTPUT_FILE}`);

  console.log("\n🎉 Schema generation complete!");
}

/**
 * Generate JSON Schema content from the Zod schemas file.
 */
async function generateJsonSchemaContent(
  zodSchemasFile: string
): Promise<string> {
  // Convert to file:// URL for dynamic import (required on Windows)
  const fileUrl = new URL(`file:///${zodSchemasFile.replace(/\\/g, "/")}`);
  const schemas = await import(fileUrl.href);

  // Mark spec-owned schema instances with their canonical ids so every
  // reference to them is emitted as `$ref: "#/$defs/<Name>"` instead of an
  // inlined, Zod-derived approximation of the core spec shape.
  const specOwnedNames = new Set(Object.values(SPEC_OWNED_DEFS));
  for (const [exportName, defName] of Object.entries(SPEC_OWNED_DEFS)) {
    const schema = schemas[exportName];
    if (schema) {
      globalRegistry.add(schema as $ZodType, { id: defName });
    }
  }

  const jsonSchema: {
    $schema: string;
    $id: string;
    title: string;
    description: string;
    $defs: Record<string, unknown>;
  } = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://modelcontextprotocol.io/ext-tasks/schema.json",
    title: "MCP Tasks Extension",
    description:
      "JSON Schema for MCP Tasks extension protocol messages. Extension Identifier: io.modelcontextprotocol/tasks",
    $defs: {},
  };

  const conversionFailures: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    if (
      name.endsWith("Schema") &&
      typeof schema === "object" &&
      schema !== null
    ) {
      const typeName = name.replace(/Schema$/, "");

      // Skip SDK external types, local replacement types, and spec-owned
      // types — only include task-specific types. Spec-owned definitions are
      // spliced from the vendored canonical spec schema below.
      if (name in LOCAL_SCHEMA_REPLACEMENTS || name in SPEC_OWNED_DEFS) {
        continue;
      }

      try {
        const emitted = toJSONSchema(schema as $ZodType, {
          unrepresentable: "any",
          // Emit input-mode schemas: strip-mode objects stay open (no
          // `additionalProperties: false`). TypeScript interfaces are open
          // types, and closed branches inside `allOf` intersections (e.g.
          // CreateTaskResult = Result & Task & { resultType }) would make
          // the intersection unsatisfiable.
          io: "input",
        }) as Record<string, unknown>;

        // Zod nests a local $defs copy of each referenced (registered)
        // schema. JSON Pointer fragments resolve from the document root, so
        // `#/$defs/<Name>` targets the top-level canonical definitions we
        // splice from the spec — the nested Zod-derived copies are dead
        // weight and a drift hazard. Remove them.
        stripSpecOwnedDefs(emitted, specOwnedNames);

        jsonSchema.$defs[typeName] = emitted;
      } catch (error) {
        console.error(`❌ Could not convert ${name} to JSON Schema: ${error}`);
        conversionFailures.push(name);
      }
    }
  }

  if (conversionFailures.length > 0) {
    throw new Error(
      `JSON Schema conversion failed for: ${conversionFailures.join(", ")}. ` +
        "A definition must never be silently omitted from the generated artifact."
    );
  }

  spliceSpecDefinitions(jsonSchema.$defs, specOwnedNames);

  return JSON.stringify(jsonSchema, null, 2) + "\n";
}

/**
 * Remove spec-owned entries from an emitted schema's local `$defs`, dropping
 * the `$defs` object entirely if it becomes empty.
 */
function stripSpecOwnedDefs(
  emitted: Record<string, unknown>,
  specOwnedNames: Set<string>
): void {
  const localDefs = emitted.$defs as Record<string, unknown> | undefined;
  if (!localDefs) return;
  for (const name of Object.keys(localDefs)) {
    if (specOwnedNames.has(name)) {
      delete localDefs[name];
    }
  }
  if (Object.keys(localDefs).length === 0) {
    delete emitted.$defs;
  }
}

/**
 * Splice the canonical definitions for all spec-owned names — plus their
 * transitive `$ref` closure — verbatim from the vendored spec schema into
 * the output `$defs`.
 */
function spliceSpecDefinitions(
  outDefs: Record<string, unknown>,
  specOwnedNames: Set<string>
): void {
  if (!existsSync(VENDORED_SPEC_SCHEMA_FILE)) {
    throw new Error(
      `Vendored spec schema not found: ${VENDORED_SPEC_SCHEMA_FILE}. ` +
        "Run: npm run fetch:spec-schema"
    );
  }
  const spec = JSON.parse(readFileSync(VENDORED_SPEC_SCHEMA_FILE, "utf-8")) as {
    $defs?: Record<string, unknown>;
  };
  const specDefs = spec.$defs;
  if (!specDefs) {
    throw new Error("Vendored spec schema has no $defs");
  }

  // Transitive $ref closure over the vendored spec definitions.
  const closure = new Set<string>();
  const frontier = [...specOwnedNames];
  while (frontier.length > 0) {
    const name = frontier.pop()!;
    if (closure.has(name)) continue;
    const def = specDefs[name];
    if (def === undefined) {
      throw new Error(
        `Spec definition "${name}" not found in vendored spec schema. ` +
          "The vendored copy may be stale — run: npm run fetch:spec-schema"
      );
    }
    closure.add(name);
    for (const ref of collectRefs(def)) {
      if (!closure.has(ref)) frontier.push(ref);
    }
  }

  for (const name of [...closure].sort()) {
    if (name in outDefs) {
      throw new Error(
        `Name collision: extension definition "${name}" conflicts with a ` +
          "canonical spec definition of the same name"
      );
    }
    outDefs[name] = specDefs[name];
  }
}

/**
 * Collect local `#/$defs/<Name>` reference targets reachable in a schema node.
 */
function collectRefs(node: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(node)) {
    for (const item of node) {
      for (const ref of collectRefs(item)) out.add(ref);
    }
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const match = value.match(/^#\/\$defs\/(.+)$/);
        if (match) out.add(match[1]);
      } else {
        for (const ref of collectRefs(value)) out.add(ref);
      }
    }
  }
  return out;
}

/**
 * Post-process generated Zod schemas for project compatibility.
 */
function postProcess(content: string): string {
  // 1. Rewrite to zod/v4
  content = content.replace(
    'import { z } from "zod";',
    'import { z } from "zod/v4";'
  );

  // 2. Replace z.any() placeholders for spec-owned imported types with
  // permissive local stand-ins carrying canonical `.meta({ id })` marks.
  for (const [schemaName, replacement] of Object.entries(
    LOCAL_SCHEMA_REPLACEMENTS
  )) {
    content = content.replace(
      new RegExp(
        `(?:export )?const ${schemaName} = z\\.any\\(\\);`,
        "g"
      ),
      `const ${schemaName} = ${replacement};`
    );
  }

  // 3. Fail on any leftover placeholder: an unmapped z.any() would emit `{}`
  // (accept-everything) into the artifact — the exact defect class this
  // pipeline exists to prevent.
  const leftover = [...content.matchAll(/const (\w+) = z\.any\(\);/g)].map(
    (m) => m[1]
  );
  if (leftover.length > 0) {
    throw new Error(
      `Unmapped external type placeholder(s): ${leftover.join(", ")}. ` +
        "Add each to LOCAL_SCHEMA_REPLACEMENTS (and SPEC_OWNED_DEFS if the " +
        "canonical definition should be spliced from the vendored spec)."
    );
  }

  // 4. Replace z.record().and(z.object({...})) with z.object({...}).passthrough()
  content = replaceRecordAndWithPassthrough(content);

  // 5. Add header comment
  content = content.replace(
    "// Generated by ts-to-zod",
    `// Generated by ts-to-zod
// Post-processed for Zod v4 compatibility and MCP SDK integration
// Run: npm run generate:schemas`
  );

  return content;
}

/**
 * Replace z.record(z.string(), z.unknown()).and(z.object({...})) with z.object({...}).passthrough()
 * Uses brace-counting to handle nested objects correctly.
 * passthrough() works in both Zod v3 and v4, allowing extra properties.
 */
function replaceRecordAndWithPassthrough(content: string): string {
  const pattern = "z.record(z.string(), z.unknown()).and(z.object({";
  let result = content;
  let startIndex = 0;

  while (true) {
    const matchStart = result.indexOf(pattern, startIndex);
    if (matchStart === -1) break;

    const objectStart = matchStart + pattern.length;
    let braceCount = 1;
    let i = objectStart;

    while (i < result.length && braceCount > 0) {
      if (result[i] === "{") braceCount++;
      else if (result[i] === "}") braceCount--;
      i++;
    }

    if (result.slice(i, i + 2) === "))") {
      const objectContent = result.slice(objectStart, i - 1);
      const replacement = `z.object({${objectContent}}).passthrough()`;
      result = result.slice(0, matchStart) + replacement + result.slice(i + 2);
      startIndex = matchStart + replacement.length;
    } else {
      startIndex = i;
    }
  }

  return result;
}

main().catch((error) => {
  console.error("❌ Schema generation failed:", error);
  process.exit(1);
});
