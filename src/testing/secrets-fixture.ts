/**
 * The `SECRETS_ENCRYPTION_KEY` every dbos test env uses.
 *
 * Plan row 43 / D43.1. Until this row, every unit and e2e spec in this repo passed
 * an all-zeros 64-hex key through `loadEnv`. That is not a neutral placeholder: design-delta
 * §11.7:2309-2318 records the real incident it caused — `docker-compose.test.yml` used to
 * override the api's key to all-zeros while dbos kept the Compose dev key, so every
 * provider credential the api ENCRYPTED failed `decryptSecret` in the worker. Row 62
 * deleted that override; row 43 makes the value itself un-loadable, in-process, in both
 * services, so it cannot come back through a different door.
 *
 * A single authored home rather than sixteen literals: the value is meaningless, but
 * "every spec uses the SAME key" is not — it is the in-repo shadow of the invariant root's
 * `compose-config.test.ts` PART V invariant 5 enforces between the api and dbos containers
 * ("api and dbos share ONE secrets key"; they must be identical WITHIN an environment and
 * distinct ACROSS environments, per D43.1/S5). `secrets-fixture.test.ts` asserts no
 * all-zeros key survives anywhere in this repo, which is what lets a lane that was not
 * executed in a given run still be trusted to boot.
 *
 * Structurally valid on purpose: 64 hex characters, i.e. a 32-byte AES-256-GCM key, the
 * shape `openssl rand -hex 32` produces. It is a TEST value and is in version control, so
 * it must never be used anywhere real.
 */
export const TEST_SECRETS_ENCRYPTION_KEY =
  "7c4a8d09ca3762af61e59520943dc26494f8941b1a3c5f9e2d6b0a7e4f13c85d";
