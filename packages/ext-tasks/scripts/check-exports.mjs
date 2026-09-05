import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageName = manifest.name;
const publicSubpaths = ["core", "core/v1", "core/v2", "client"];
const expectedRuntimeExports = {
  core: [
    "ProtocolDecodeError",
    "createRuntimeCodec",
    "expectEnum",
    "expectNumber",
    "expectRecord",
    "expectString",
    "isJsonArray",
    "isJsonValue",
    "taskId",
  ],
  "core/v1": [
    "CallToolRequestV1Codec",
    "CallToolResultV1Codec",
    "CancelTaskRequestV1Codec",
    "CancelTaskResultV1Codec",
    "CreateTaskResultV1Codec",
    "GetTaskRequestV1Codec",
    "GetTaskResultRequestV1Codec",
    "GetTaskResultV1Codec",
    "ListTasksRequestV1Codec",
    "ListTasksResultV1Codec",
    "ServerTaskCapabilitiesV1Codec",
    "TaskResultV1Codec",
    "TaskStatusNotificationV1Codec",
    "TaskStatusV1Codec",
    "TaskStatusesV1",
    "TaskV1Codec",
    "ToolV1Codec",
    "callToolAsTaskV1",
    "hasTaskCancelCapabilityV1",
    "hasTaskListCapabilityV1",
    "hasTaskToolCallCapabilityV1",
    "isTaskEligibleMethodV1",
    "shouldCallToolAsTaskV1",
  ],
  "core/v2": [
    "CLIENT_CAPABILITIES_META_KEY_V2",
    "CallToolResultV2Codec",
    "CancelTaskRequestV2Codec",
    "CancelTaskResultV2Codec",
    "CancelledTaskV2Codec",
    "CompletedTaskV2Codec",
    "CreateMessageRequestV2Codec",
    "CreateMessageResultV2Codec",
    "CreateTaskResultV2Codec",
    "DetailedTaskV2Codec",
    "ElicitRequestV2Codec",
    "ElicitResultV2Codec",
    "ErrorV2Codec",
    "FailedTaskV2Codec",
    "GetTaskRequestV2Codec",
    "GetTaskResultV2Codec",
    "InputRequestV2Codec",
    "InputRequestsV2Codec",
    "InputRequiredTaskV2Codec",
    "InputResponseV2Codec",
    "InputResponsesV2Codec",
    "ListRootsRequestV2Codec",
    "ListRootsResultV2Codec",
    "TASKS_EXTENSION_ID_V2",
    "TaskStatusNotificationParamsV2Codec",
    "TaskStatusNotificationV2Codec",
    "TaskSubscriptionAcknowledgedNotificationsV2Codec",
    "TaskSubscriptionNotificationsV2Codec",
    "TaskV2Codec",
    "TasksExtensionCapabilityV2Codec",
    "ToolV2Codec",
    "UpdateTaskRequestV2Codec",
    "UpdateTaskResultV2Codec",
    "WorkingTaskV2Codec",
    "contributeTaskFilterV2",
    "hasTaskClientCapabilityV2",
    "hasTaskServerCapabilityV2",
    "isCancelTaskRequestV2",
    "isCreateTaskResultV2",
    "isDetailedTaskV2",
    "isGetTaskRequestV2",
    "isTaskStatusNotificationV2",
    "isTaskV2",
    "isToolCallTaskResultV2",
    "isUpdateTaskRequestV2",
    "readAcceptedTaskIdsV2",
    "withTaskCapabilityV2",
  ],
  client: [
    "DispatchError",
    "InputCorrelationError",
    "JsonRpcResponseError",
    "TaskCancellationUnsupportedError",
    "TaskExecutionClosedError",
    "TaskUpdatesAlreadyAcquiredError",
    "createSessionPortFromClient",
    "withTasks",
  ],
};
const removedPublicAliasesV2 = [
  "EligibleTaskResultV2",
  "TaskExtensionCapabilitiesV2",
  "TaskExtensionCapabilitiesV2Codec",
  "ToolCallResultV2",
  "ToolCallResultV2Codec",
  "isEligibleTaskResultV2",
  "supportsTasksExtensionV2",
];
const removedRuntimeAliasesV2 = [
  "TaskExtensionCapabilitiesV2Codec",
  "ToolCallResultV2Codec",
  "isEligibleTaskResultV2",
  "supportsTasksExtensionV2",
];
const unbarreledInternalTypesV2 = [
  "ContentBlockV2",
  "IconV2",
  "JsonRpcRequestV2",
  "OpenObjectV2",
  "ToolAnnotationsV2",
];
const unavailableV2Names = [
  ...removedPublicAliasesV2,
  ...unbarreledInternalTypesV2,
];

function sorted(values) {
  return [...values].sort();
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function expectFailure(command, args, description, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageDirectory,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  assert.notEqual(result.status, 0, `${description} unexpectedly succeeded`);
}

async function checkBuiltContract() {
  const expectedSubpaths = publicSubpaths.map((subpath) => `./${subpath}`);
  assert.deepEqual(
    sorted(Object.keys(manifest.exports ?? {})),
    sorted(expectedSubpaths),
    "exports must contain exactly the four public subpaths and no root export",
  );

  const typeMappings = manifest.typesVersions?.["*"] ?? {};
  assert.deepEqual(
    sorted(Object.keys(typeMappings)),
    sorted(publicSubpaths),
    "typesVersions keys must exactly match exports",
  );

  for (const subpath of publicSubpaths) {
    const conditions = manifest.exports[`./${subpath}`];
    assert.deepEqual(
      Object.keys(conditions),
      ["types", "import"],
      `Unexpected export conditions for ./${subpath}`,
    );
    assert.deepEqual(
      typeMappings[subpath],
      [conditions.types.replace(/^\.\//, "")],
      `typesVersions does not match exports for ./${subpath}`,
    );
    await access(resolve(packageDirectory, conditions.import));
    await access(resolve(packageDirectory, conditions.types));

    const namespace = await import(
      `${pathToFileURL(resolve(packageDirectory, conditions.import)).href}?contract-check`
    );
    assert.deepEqual(
      Object.keys(namespace).sort(),
      [...expectedRuntimeExports[subpath]].sort(),
      `Runtime export snapshot changed for ${packageName}/${subpath}`,
    );
    if (subpath === "core/v2") {
      for (const alias of removedRuntimeAliasesV2)
        assert.equal(
          alias in namespace,
          false,
          `Removed V2 alias returned: ${alias}`,
        );
    }
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

async function checkPackedContract() {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "ext-tasks-contract-"),
  );
  try {
    const packDirectory = join(temporaryDirectory, "pack");
    const consumerDirectory = join(temporaryDirectory, "consumer");
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([mkdir(packDirectory), mkdir(consumerDirectory)]),
    );

    const packOutput = run(process.platform === "win32" ? "npm.cmd" : "npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      packDirectory,
    ]);
    const [{ filename, files }] = JSON.parse(packOutput);
    const packedPaths = files.map(({ path }) => path);
    assert.equal(
      packedPaths.some((path) =>
        /(^|\/)(src|test-support|tests?)(\/|$)/u.test(path),
      ),
      false,
      "Tarball includes source, test-support, or test files",
    );
    assert.equal(
      packedPaths.some((path) => /(?:^|\/)package\.json$/u.test(path)),
      true,
      "Tarball is missing package.json",
    );

    const tarball = join(packDirectory, filename);
    await writeFile(
      join(consumerDirectory, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );
    run(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        resolve(
          packageDirectory,
          "../../node_modules/@modelcontextprotocol/client",
        ),
        tarball,
      ],
      { cwd: consumerDirectory },
    );

    const positiveImports = publicSubpaths
      .map(
        (subpath) =>
          `import * as ${subpath.replace(/\W/gu, "_")} from "${packageName}/${subpath}";`,
      )
      .join("\n");
    await writeFile(
      join(consumerDirectory, "positive.ts"),
      `${positiveImports}\nvoid 0;\n`,
    );
    const baseCompilerOptions = {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      noUncheckedSideEffectImports: true,
    };
    const tsc = resolve(
      packageDirectory,
      "../../node_modules/typescript/bin/tsc",
    );
    for (const moduleResolution of ["NodeNext", "Bundler"]) {
      const compilerOptions = {
        ...baseCompilerOptions,
        module: moduleResolution === "Bundler" ? "ESNext" : "NodeNext",
        moduleResolution,
      };
      await writeFile(
        join(consumerDirectory, "tsconfig.json"),
        JSON.stringify({ compilerOptions, files: ["positive.ts"] }),
      );
      run(process.execPath, [tsc, "-p", "tsconfig.json"], {
        cwd: consumerDirectory,
      });
    }

    const negativeImports = [
      ["root", `import "${packageName}";`],
      ["server", `import "${packageName}/server";`],
      ["client-internal", `import "${packageName}/client/api";`],
      ["core-internal", `import "${packageName}/core/internal/codec";`],
      [
        "test-support",
        `import "${packageName}/test-support/client/fake-port";`,
      ],
      ...unavailableV2Names.map((alias) => [
        `removed-v2-${alias}`,
        `import { ${alias} } from "${packageName}/core/v2";`,
      ]),
    ];
    for (const [name, source] of negativeImports) {
      const file = `negative-${name}.ts`;
      await writeFile(join(consumerDirectory, file), `${source}\n`);
      await writeFile(
        join(consumerDirectory, "tsconfig.json"),
        JSON.stringify({ compilerOptions: baseCompilerOptions, files: [file] }),
      );
      expectFailure(process.execPath, [tsc, "-p", "tsconfig.json"], name, {
        cwd: consumerDirectory,
      });
    }

    const runtimeSource = `${publicSubpaths
      .map((subpath) => `await import("${packageName}/${subpath}");`)
      .join("\n")}\n`;
    await writeFile(join(consumerDirectory, "runtime.mjs"), runtimeSource);
    run(process.execPath, ["runtime.mjs"], { cwd: consumerDirectory });

    for (const unsupported of [
      packageName,
      `${packageName}/client/api`,
      `${packageName}/core/internal/codec`,
      `${packageName}/test-support/client/fake-port`,
    ]) {
      expectFailure(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(unsupported)})`,
        ],
        `runtime import ${unsupported}`,
        { cwd: consumerDirectory },
      );
    }

    const installedFiles = await listFiles(
      join(consumerDirectory, "node_modules", ...packageName.split("/")),
    );
    assert.equal(
      installedFiles.some((path) =>
        /(?:^|\/)(?:test-support|tests?)(?:\/|$)/u.test(
          relative(consumerDirectory, path),
        ),
      ),
      false,
      "Installed package includes test support",
    );
    console.log(`Validated packed consumer contract: ${filename}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await checkBuiltContract();
if (process.argv.includes("--pack")) await checkPackedContract();
