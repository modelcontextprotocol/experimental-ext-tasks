# MCP Tasks Extension

This repository contains the official [Model Context Protocol](https://modelcontextprotocol.io) Tasks extension (`io.modelcontextprotocol/tasks`), based on [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663).

## Why Tasks?

Some MCP requests finish quickly. Others run for minutes, wait for human input, or need to survive a disconnected client. The Tasks extension lets a receiver return a durable task handle so the requester can follow progress and retrieve the result later.

Use Tasks for long computations, approval workflows, external job systems, and call-now/fetch-later APIs.

**Extension Identifier:** `io.modelcontextprotocol/tasks`

## Use it from TypeScript

The `@modelcontextprotocol/ext-tasks` package provides generation-agnostic requester lifecycle APIs and 2025-11-25 Tasks receiver support. Start with the [TypeScript package guide](https://modelcontextprotocol.github.io/ext-tasks/typescript/) or [call your first task-enabled tool](https://modelcontextprotocol.github.io/ext-tasks/typescript/getting-started.html).

## Schemas

| Version      | Status      | TypeScript                                 | JSON Schema                                    |
| ------------ | ----------- | ------------------------------------------ | ---------------------------------------------- |
| `2026-07-28` | Stable      | [`schema.ts`](schema/2026-07-28/schema.ts) | [`schema.json`](schema/2026-07-28/schema.json) |
| `draft`      | Development | [`schema.ts`](schema/draft/schema.ts)      | [`schema.json`](schema/draft/schema.json)      |

Released schema directories are immutable snapshots with version-specific JSON Schema identifiers. Development and schema generation target `schema/draft/` only. To create a release snapshot from the current draft:

```bash
npm run snapshot:schema -- YYYY-MM-DD
```

## Development

### SDK Package

The redistributable package lives in `packages/ext-tasks` and publishes as `@modelcontextprotocol/ext-tasks`.

```bash
# Run schema, package, and packed-consumer checks
npm run check

# Run the package tests in watch mode
npm run test:watch

# Create the publishable tarball
npm run pack:package
```

The package intentionally has no root export. Consumers import `/client`, `/receiver`, `/core`, `/core/v1`, or `/core/v2`; the guide explains which entry point owns each workflow.

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
