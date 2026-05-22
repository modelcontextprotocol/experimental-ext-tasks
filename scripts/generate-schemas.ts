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
 * ts-to-zod generates `import { z } from "zod"`. We rewrite to `import { z } from "zod/v4"`
 * to match MCP SDK's zod/v4 schemas.
 *
 * ### 2. External Type References (`z.any()` → SDK schemas)
 * ts-to-zod cannot resolve types imported from @modelcontextprotocol/sdk.
 * We replace z.any() placeholders with actual SDK schema imports.
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
import { toJSONSchema, type $ZodType } from "zod/v4/core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");

const SCHEMA_DIR = join(PROJECT_ROOT, "schema", "draft");
const SPEC_TYPES_FILE = join(SCHEMA_DIR, "schema.ts");
const GENERATED_DIR = join(SCHEMA_DIR, "generated");
const SCHEMA_OUTPUT_FILE = join(GENERATED_DIR, "schema.ts");
const JSON_SCHEMA_OUTPUT_FILE = join(SCHEMA_DIR, "schema.json");

/**
 * Mapping from ts-to-zod generated placeholder names to actual SDK schema exports.
 * Only includes types that have matching SDK exports.
 */
const EXTERNAL_TYPE_SCHEMAS: string[] = [
  "JSONRPCRequestSchema",
  "JSONRPCNotificationSchema",
  "PaginatedRequestSchema",
  "PaginatedResultSchema",
  "ResultSchema",
  "RequestIdSchema",
  "ProgressTokenSchema",
  "CursorSchema",
];

/**
 * External types that don't have direct SDK schema exports.
 * We replace their z.any() placeholders with local Zod definitions.
 */
const LOCAL_SCHEMA_REPLACEMENTS: Record<string, string> = {
  RequestParamsSchema: `z.object({
  _meta: z.object({ progressToken: ProgressTokenSchema.optional() }).passthrough().optional(),
}).passthrough()`,
  NotificationParamsSchema: `z.object({
  _meta: z.record(z.string(), z.unknown()).optional(),
}).passthrough()`,
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

  for (const [name, schema] of Object.entries(schemas)) {
    if (
      name.endsWith("Schema") &&
      typeof schema === "object" &&
      schema !== null
    ) {
      const typeName = name.replace(/Schema$/, "");

      // Skip SDK external types and local replacement types — only include task-specific types
      if (
        EXTERNAL_TYPE_SCHEMAS.includes(name) ||
        name in LOCAL_SCHEMA_REPLACEMENTS
      ) {
        continue;
      }

      try {
        jsonSchema.$defs[typeName] = toJSONSchema(schema as $ZodType, {
          unrepresentable: "any",
        });
      } catch (error) {
        console.warn(`⚠️  Could not convert ${name} to JSON Schema: ${error}`);
      }
    }
  }

  return JSON.stringify(jsonSchema, null, 2) + "\n";
}

/**
 * Post-process generated Zod schemas for project compatibility.
 */
function postProcess(content: string): string {
  // 1. Rewrite to zod/v4 and add MCP SDK schema imports
  const sdkImports = EXTERNAL_TYPE_SCHEMAS.join(",\n  ");

  content = content.replace(
    'import { z } from "zod";',
    `import { z } from "zod/v4";
import {
  ${sdkImports},
} from "@modelcontextprotocol/sdk/types.js";`
  );

  // 2. Remove z.any() placeholders for SDK-imported external types
  for (const schemaName of EXTERNAL_TYPE_SCHEMAS) {
    content = content.replace(
      new RegExp(
        `(?:export )?const ${schemaName} = z\\.any\\(\\);\\n?`,
        "g"
      ),
      ""
    );
  }

  // 3. Replace z.any() placeholders for locally-defined types
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
