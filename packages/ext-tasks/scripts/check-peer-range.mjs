import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryDirectory = resolve(packageDirectory, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const clientSpecifier = process.argv[2];

assert.match(
  clientSpecifier ?? "",
  /^(?:2|2\.0\.0)$/u,
  "Pass exactly 2.0.0 or 2: 2 resolves the latest stable 2.x release.",
);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function main() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "ext-tasks-peer-"));
  try {
    const packDirectory = join(temporaryDirectory, "pack");
    const consumerDirectory = join(temporaryDirectory, "consumer");
    await Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]);

    const [{ filename }] = JSON.parse(
      run(npm, [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ]),
    );
    const tarball = join(packDirectory, filename);
    await writeFile(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    run(
      npm,
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        `@modelcontextprotocol/client@${clientSpecifier}`,
        tarball,
      ],
      { cwd: consumerDirectory },
    );

    const installedClientManifest = JSON.parse(
      await readFile(
        join(
          consumerDirectory,
          "node_modules",
          "@modelcontextprotocol",
          "client",
          "package.json",
        ),
        "utf8",
      ),
    );
    assert.match(
      installedClientManifest.version,
      /^2\./u,
      `Expected @modelcontextprotocol/client 2.x, received ${installedClientManifest.version}`,
    );

    await writeFile(
      join(consumerDirectory, "adapter.ts"),
      `import { withTasks } from "@modelcontextprotocol/ext-tasks/client";
import type { ConnectedMcpSessionPort } from "@modelcontextprotocol/ext-tasks/client";
import type { Client } from "@modelcontextprotocol/client";

declare const port: ConnectedMcpSessionPort;
declare const client: Client;
const session = withTasks(port);
void session;
void client;
`,
    );
    await writeFile(
      join(consumerDirectory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        files: ["adapter.ts"],
      }),
    );
    run(
      process.execPath,
      [
        resolve(repositoryDirectory, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.json",
      ],
      { cwd: consumerDirectory },
    );

    await writeFile(
      join(consumerDirectory, "runtime.mjs"),
      'await import("@modelcontextprotocol/ext-tasks/client");\n',
    );
    run(process.execPath, ["runtime.mjs"], { cwd: consumerDirectory });

    console.log(
      `Validated packed @modelcontextprotocol/ext-tasks against @modelcontextprotocol/client ${installedClientManifest.version}`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
