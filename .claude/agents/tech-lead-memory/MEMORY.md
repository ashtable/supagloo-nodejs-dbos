# Tech Lead — Shared Memory Index (this repo)

This is the shared, cross-session memory for the **tech-lead** (Opus) and
**fabulous-tech-lead** (Fable) persona, **scoped to this repository**. Both
engines read and write here; this memory does not cross into other repos.

Each entry below points to one memory file in this directory. Keep this index to
one line per memory (`- [Title](file.md) — hook`); put the actual content in the
individual files, never here.

## Memories

<!-- Add entries as you learn durable technical facts. Example:
- [Non-UI e2e run via node test runner](non-ui-e2e-runner.md) — how integration tests are invoked
-->

- [db-lib submodule / Dockerfile pin lockstep](db-lib-submodule-dockerfile-pin-lockstep.md) — how to bump the database-lib submodule; the Dockerfile ARG must move in the same commit (pin test enforces it)
