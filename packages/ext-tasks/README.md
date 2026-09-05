# `@modelcontextprotocol/ext-tasks`

Protocol declarations and requester-side lifecycle support for MCP Tasks.

This package intentionally has no root entry point. Import the role or protocol
generation needed by the application:

```ts
import { withTasks } from "@modelcontextprotocol/ext-tasks/client";
```

The public package subpaths are:

- `@modelcontextprotocol/ext-tasks/core`
- `@modelcontextprotocol/ext-tasks/core/v1`
- `@modelcontextprotocol/ext-tasks/core/v2`
- `@modelcontextprotocol/ext-tasks/client`

Source is emitted as ESM JavaScript, TypeScript declarations, and source maps
in `dist/`.
