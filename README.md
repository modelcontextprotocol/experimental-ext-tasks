# MCP Tasks Extension
This repository contains the official [Model Context Protocol](https://modelcontextprotocol.io) Tasks extension (`io.modelcontextprotocol/tasks`), based on [SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663).

## Overview

This extension defines the **Tasks** primitive for the Model Context Protocol (MCP). Tasks are durable state machines that carry information about the underlying execution state of a request, enabling requestor polling and deferred result retrieval. Each task is uniquely identifiable by a receiver-generated **task ID**.

Tasks are useful for:

- Representing expensive computations and batch processing requests
- Integrating seamlessly with external job/workflow APIs
- Enabling call-now, fetch-later execution patterns

**Extension Identifier:** `io.modelcontextprotocol/tasks`

## Development

### Schema Generation

The JSON Schema is auto-generated from the TypeScript type definitions using [ts-to-zod](https://github.com/fabien0102/ts-to-zod) and Zod's `toJSONSchema()`. Do not hand-edit `schema.json` or `generated/schema.ts`.

```bash
# Generate Zod schemas and JSON Schema from schema.ts
npm run generate:schemas

# Verify TypeScript compiles and generated files are up to date
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
