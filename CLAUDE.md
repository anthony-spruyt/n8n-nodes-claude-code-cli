# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An n8n community node (`n8n-nodes-claude-code-cli`) that wraps the Claude Code CLI, providing 4 operations (executePrompt, executeWithContext, continueSession, resumeSession) across 5 connection modes (local, ssh, docker, k8sEphemeral, k8sPersistent).

## Commands

```bash
npm run build          # typecheck → esbuild bundle → generate .d.ts → copy icons
npm run dev            # TypeScript watch mode
npm run lint           # Biome lint
npm run format         # Biome format (writes changes)
npm run check          # Biome format check (read-only)
npm run typecheck      # TypeScript strict type checking
npm run test           # Unit tests (tests/utils only)
npm run test:all       # Unit + integration tests
npm run test:coverage  # Unit tests with v8 coverage
npm run test:watch     # Vitest watch mode
```

Run a single test file: `npx vitest run tests/utils/commandBuilder.test.ts`

## Architecture

### Node Entry Point

`nodes/ClaudeCode/ClaudeCode.node.ts` — implements `INodeType`. The `execute` method reads parameters via `optionsBuilder`, dispatches to the appropriate executor via `ExecutorFactory`, and parses output via `outputParser`.

### Transport Layer (`nodes/ClaudeCode/transport/`)

Each connection mode has an executor implementing `IClaudeCodeExecutor` (execute + testConnection). `ExecutorFactory` selects the right one based on `ConnectionMode`.

- **LocalExecutor** — child_process.spawn
- **SshExecutor** — ssh2 library
- **DockerExecutor** — docker exec via Docker socket
- **K8sEphemeralExecutor** — creates temporary K8s pod, polls for completion
- **K8sPersistentExecutor** — manages a long-lived K8s deployment, watches pod logs

### Utilities (`nodes/ClaudeCode/utils/`)

- **commandBuilder** — translates `ClaudeCodeExecutionOptions` into CLI args array; handles shell escaping for SSH/Docker
- **optionsBuilder** — maps n8n node parameters to `ClaudeCodeExecutionOptions`
- **outputParser** — parses json, text, and stream-json output formats into normalized `ClaudeCodeResult`

### UI Descriptions (`nodes/ClaudeCode/descriptions/`)

12 modular files defining n8n UI properties (operations, model config, session handling, permissions, etc.). These are composed into the node's `description.properties`.

### Credentials (`credentials/`)

One `ICredentialType` per connection mode. Each defines connection-specific fields (host/port for SSH, container name for Docker, namespace/image for K8s, etc.).

### Types (`nodes/ClaudeCode/interfaces/ClaudeCodeTypes.ts`)

All shared types and enums: `ConnectionMode`, `OutputFormat`, `PermissionMode`, `ClaudeCodeOperation`, `ClaudeCodeExecutionOptions`, `ClaudeCodeResult`, stream event types, credential interfaces.

## Build & Publish

- esbuild bundles to CommonJS (node18 target) in `dist/`
- `n8n-workflow` is a peer dependency (not bundled); `ssh2` is external (dynamically required)
- Zero production dependencies
- Upstream uses semantic-release on `main` to auto-publish with provenance. **In this fork the GitHub workflows are disabled** — releases are published manually (see below).

## Fork & Publishing

This fork publishes to npm as `n8n-nodes-claude-code-cli-aspruyt`.

`main` is kept as a clean mirror of upstream. Everything that differs from
upstream — npm identity, publishing tooling, env — lives on the release branch
`npm-publish-v3`:

- `package.json` — package `name`, `homepage`, `repository`
- `publish-fork.sh` — the publish script
- `.gitignore` — ignores packed `*.tgz`
- `CLAUDE.md` — this file

To release: merge `main` into `npm-publish-v3`, bump `version` in
`package.json`, push, then run `./publish-fork.sh`.

**There is no node/npm on the dev host** — every npm command runs in Docker.
`publish-fork.sh` handles this: it builds from a throwaway worktree of
`origin/npm-publish-v3` (so it publishes what is pushed, not your working
tree), runs install/build/lint/test, packs, and publishes the tarball. It
aborts if the version is already on the registry or if the package still
carries the upstream name. Use `--dry-run` to verify without publishing.

npm auth is interactive web login with MFA: the script prints an npmjs.com URL
to open in a browser. Publishes are therefore unsigned — no provenance, which
matches every prior fork release.

## Conventions

- Biome for linting and formatting (tab indentation, double quotes)
- Conventional commits required (semantic-release uses them for versioning)
- TypeScript strict mode; no unused variables/parameters
- Tests use Vitest; integration tests use testcontainers
