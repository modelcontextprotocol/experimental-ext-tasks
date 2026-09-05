# `@modelcontextprotocol/ext-tasks`

Protocol Zod schemas and requester-side lifecycle support for MCP Tasks.

This package intentionally has no root entry point. Import the role or protocol
generation needed by the application:

```ts
import { withTasks } from "@modelcontextprotocol/ext-tasks/client";
```

```ts
import { TaskV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import * as z from "zod/v4";

TaskV2Schema.parse(taskPayload);

const execution = await withTasks(client).callTool(
  "generate_report",
  undefined,
  {
    resultSchema: z.object({ reportUrl: z.url() }),
  },
);
const { reportUrl } = await execution.result();
```

The public package subpaths are:

- `@modelcontextprotocol/ext-tasks/core`
- `@modelcontextprotocol/ext-tasks/core/v1`
- `@modelcontextprotocol/ext-tasks/core/v2`
- `@modelcontextprotocol/ext-tasks/client`

Source is emitted as ESM JavaScript, TypeScript declarations, and source maps
in `dist/`.
