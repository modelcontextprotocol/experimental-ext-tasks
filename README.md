# MCP Tasks Extension
This repository contains the official [Model Context Protocol](https://modelcontextprotocol.io) Tasks extension (`io.modelcontextprotocol/tasks`), based on [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663).

## Overview

This extension defines the **Tasks** primitive for the Model Context Protocol (MCP). Tasks are durable state machines that carry information about the underlying execution state of a request, enabling requestor polling and deferred result retrieval. Each task is uniquely identifiable by a receiver-generated **task ID**.

Tasks are useful for:

- Representing expensive computations and batch processing requests
- Integrating seamlessly with external job/workflow APIs
- Enabling call-now, fetch-later execution patterns

**Extension Identifier:** `io.modelcontextprotocol/tasks`

## Schemas

| Version | Status | TypeScript | JSON Schema |
| --- | --- | --- | --- |
| `2026-07-28` | Stable | [`schema.ts`](schema/2026-07-28/schema.ts) | [`schema.json`](schema/2026-07-28/schema.json) |
| `draft` | Development | [`schema.ts`](schema/draft/schema.ts) | [`schema.json`](schema/draft/schema.json) |

Released schema directories are immutable snapshots with version-specific JSON Schema identifiers. Development and schema generation target `schema/draft/` only. To create a release snapshot from the current draft:

```bash
npm run snapshot:schema -- YYYY-MM-DD
```

## Development

### Schema Generation

The draft JSON Schema is auto-generated from the TypeScript type definitions using [ts-to-zod](https://github.com/fabien0102/ts-to-zod) and Zod's `toJSONSchema()`. Do not hand-edit `schema.json` or `generated/schema.ts`.

```bash
# Generate draft Zod schemas and JSON Schema from schema.ts
npm run generate:schemas

# Verify TypeScript compiles and draft generated files are up to date
npm run check:schema

```

## Governance

This repository follows the [Model Context Protocol Governance](https://modelcontextprotocol.io/community/governance) process. See [MAINTAINERS.md](MAINTAINERS.md) for the list of maintainers specific to this repository.

## Policies

This repository follows the Model Context Protocol project policies:

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing Guidelines](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)

## License

This project is licensed under the Apache License 2.0. See [LICENSE](https://github.com/modelcontextprotocol/ext-tasks/blob/main/LICENSE) for details.
