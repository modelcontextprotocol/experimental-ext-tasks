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
const publicSubpaths = ["core", "core/v1", "core/v2", "client", "receiver"];
const expectedRuntimeExports = {
  core: [
    "JsonValueCodec",
    "ProtocolDecodeError",
    "isJsonValue",
    "runtimeCodecFromStandardSchema",
    "taskId",
    "toJsonValue",
  ],
  "core/v1": [
    "CallToolAsTaskRequestV1Schema",
    "CallToolRequestV1Schema",
    "CallToolResultV1Schema",
    "CancelTaskRequestV1Schema",
    "CancelTaskResultV1Schema",
    "ContentBlockV1Schema",
    "CreateTaskResultV1Schema",
    "GetTaskRequestV1Schema",
    "GetTaskResultRequestV1Schema",
    "GetTaskResultV1Schema",
    "JsonRpcRequestIdV1Schema",
    "ListTasksRequestV1Schema",
    "ListTasksResultV1Schema",
    "ServerCapabilitiesV1Schema",
    "ServerTaskCapabilitiesV1Schema",
    "TaskEligibleMethodV1Schema",
    "TaskMetadataV1Schema",
    "TaskResultV1Schema",
    "TaskStatusNotificationV1Schema",
    "TaskStatusV1Schema",
    "TaskStatusesV1",
    "TaskSupportV1Schema",
    "TaskV1Schema",
    "ToolExecutionV1Schema",
    "ToolV1Schema",
    "callToolAsTaskV1",
    "hasTaskCancelCapabilityV1",
    "hasTaskListCapabilityV1",
    "hasTaskToolCallCapabilityV1",
    "isTaskEligibleMethodV1",
    "shouldCallToolAsTaskV1",
  ],
  "core/v2": [
    "CLIENT_CAPABILITIES_META_KEY_V2",
    "CallToolResultV2Schema",
    "CancelTaskRequestV2Schema",
    "CancelTaskResultV2Schema",
    "CancelledTaskV2Schema",
    "ClientTaskCapabilityEnvelopeV2Schema",
    "CompletedTaskV2Schema",
    "ContentBlockV2Schema",
    "CreateMessageRequestV2Schema",
    "CreateMessageResultV2Schema",
    "CreateTaskResultV2Schema",
    "DetailedTaskV2Schema",
    "ElicitRequestV2Schema",
    "ElicitResultV2Schema",
    "ErrorV2Schema",
    "FailedTaskV2Schema",
    "GetTaskRequestV2Schema",
    "GetTaskResultV2Schema",
    "InputRequestV2Schema",
    "InputRequestsV2Schema",
    "InputRequiredCallToolResultV2Schema",
    "InputRequiredTaskV2Schema",
    "InputResponseV2Schema",
    "InputResponsesV2Schema",
    "ListRootsRequestV2Schema",
    "ListRootsResultV2Schema",
    "RequestIdV2Schema",
    "ServerTaskCapabilityEnvelopeV2Schema",
    "TASKS_EXTENSION_ID_V2",
    "TaskEligibleMethodV2Schema",
    "TaskStatusNotificationParamsV2Schema",
    "TaskStatusNotificationV2Schema",
    "TaskStatusV2Schema",
    "TaskSubscriptionAcknowledgedNotificationsV2Schema",
    "TaskSubscriptionNotificationsV2Schema",
    "TaskV2Schema",
    "TasksExtensionCapabilityV2Schema",
    "ToolV2Schema",
    "UpdateTaskRequestV2Schema",
    "UpdateTaskResultV2Schema",
    "WorkingTaskV2Schema",
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
    "TaskCancelledError",
    "TaskExecutionClosedError",
    "TaskFailedError",
    "TaskInputUpdateUnsupportedError",
    "TaskRecoveryOwnershipError",
    "TaskRetentionUnsupportedError",
    "TaskUpdatesAlreadyAcquiredError",
    "createApplicationInputHandler",
    "createTaskSessionEndpointId",
    "createSessionPortFromClient",
    "createTaskSessionFromClient",
    "resultFromTaskOutcome",
    "taskViewFromExecutionEvent",
    "toolDeclaration",
    "toolDeclarationFromMcpTool",
    "withRelatedTaskMetadata",
    "withTasks",
  ],
  receiver: ["bindTaskReceiver"],
};
const removedPrimaryClientNames = [
  "TaskGenerationMismatchError",
  "TaskSnapshot",
  "toolDeclarationV1",
  "toolDeclarationV2",
];
const removedCoreNames = [
  "DecodePath",
  "createRuntimeCodec",
  "expectEnum",
  "expectNumber",
  "expectRecord",
  "expectString",
  "isJsonArray",
];
const removedV1CodecNames = [
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
  "TaskV1Codec",
  "ToolV1Codec",
];
const removedV2CodecNames = [
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
];
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
    "exports must contain exactly the public subpaths and no root export",
  );
  assert.equal(
    typeof manifest.dependencies?.zod,
    "string",
    "zod must be a runtime dependency",
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
    if (subpath === "client") {
      for (const name of removedPrimaryClientNames)
        assert.equal(
          name in namespace,
          false,
          `Removed primary client export ${name} is still available`,
        );
    }
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
      "--dry-run=false",
      "--json",
      "--pack-destination",
      packDirectory,
    ]);
    const [{ filename, files }] = JSON.parse(packOutput);
    const packedPaths = files.map(({ path }) => path);
    assert.equal(
      packedPaths.includes("dist/client/index.js"),
      true,
      "Tarball is missing dist/client/index.js",
    );
    assert.equal(
      packedPaths.some((path) =>
        /(^|\/)(src|test-support|tests?)(\/|$)/u.test(path),
      ),
      false,
      "Tarball includes source, test-support, or test files",
    );
    assert.equal(
      packedPaths.some((path) => /^dist\/server\//u.test(path)),
      false,
      "Tarball includes removed server artifacts",
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
        "--dry-run=false",
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
    await access(
      join(consumerDirectory, "node_modules", "zod", "package.json"),
    );

    const positiveImports = publicSubpaths
      .map(
        (subpath) =>
          `import * as ${subpath.replace(/\W/gu, "_")} from "${packageName}/${subpath}";`,
      )
      .join("\n");
    const positiveSource = `${positiveImports}
import { withTasks } from "${packageName}/client";
import type { ConnectedMcpSessionPort, TaskEnabledSession, TaskOutcome, V2RequestFraming } from "${packageName}/client";
import { ProtocolDecodeError } from "${packageName}/core";
import type { RuntimeCodec, SynchronousStandardSchema } from "${packageName}/core";
declare const port: ConnectedMcpSessionPort;
const resultCodec: RuntimeCodec<number> = {
  parse(value) {
    if (value !== null && !Array.isArray(value) && typeof value === "object" && "value" in value && typeof value.value === "string")
      return { success: true, value: value.value.length };
    return { success: false, error: new ProtocolDecodeError("Expected value") };
  },
};
const framing: V2RequestFraming = { protocolVersion: "v2", clientInfo: { name: "x" }, clientCapabilities: {} };
void framing;
const standardSchema: SynchronousStandardSchema<number> = {
  "~standard": { version: 1, vendor: "consumer", validate: () => ({ issues: [{ message: "bad", path: ["value"] }] }) },
};
void standardSchema;
const decodeError = new ProtocolDecodeError("bad", { issues: [{ message: "bad", path: ["value"] }] });
void decodeError.details.issues;
const session = withTasks(port);
const execution = await session.callTool("example", undefined, { resultCodec });
const inferred: TaskOutcome<number> = await execution.result();
void inferred;
const taskSession: TaskEnabledSession = session;
void taskSession;
`;
    await writeFile(join(consumerDirectory, "positive.ts"), positiveSource);
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
      [
        "removed-result-codec-option",
        `import { withTasks } from "${packageName}/client";
import type { ConnectedMcpSessionPort } from "${packageName}/client";
declare const port: ConnectedMcpSessionPort;
void withTasks(port).callTool("example", undefined, { resultCodec: {} });`,
      ],
      ...removedPrimaryClientNames.map((name) => [
        `removed-client-${name}`,
        `import { ${name} } from "${packageName}/client";`,
      ]),
      ...removedCoreNames.map((name) => [
        `removed-core-${name}`,
        `import { ${name} } from "${packageName}/core";`,
      ]),
      ...removedV1CodecNames.map((name) => [
        `removed-v1-${name}`,
        `import { ${name} } from "${packageName}/core/v1";`,
      ]),
      ...removedV2CodecNames.map((name) => [
        `removed-v2-codec-${name}`,
        `import { ${name} } from "${packageName}/core/v2";`,
      ]),
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

    const installedPackageDirectory = join(
      consumerDirectory,
      "node_modules",
      ...packageName.split("/"),
    );
    const installedRelativePaths = (
      await listFiles(installedPackageDirectory)
    ).map((path) =>
      relative(installedPackageDirectory, path).replaceAll("\\", "/"),
    );
    assert.equal(
      installedRelativePaths.includes("dist/client/index.js"),
      true,
      "Installed package inventory is missing dist/client/index.js",
    );
    assert.equal(
      installedRelativePaths.some((path) =>
        /(?:^|\/)(?:test-support|tests?)(?:\/|$)/u.test(path),
      ),
      false,
      "Installed package includes test support",
    );
    assert.equal(
      installedRelativePaths.some((path) => /^dist\/server\//u.test(path)),
      false,
      "Installed package includes removed server artifacts",
    );
    console.log(`Validated packed consumer contract: ${filename}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await checkBuiltContract();
if (process.argv.includes("--pack")) await checkPackedContract();
