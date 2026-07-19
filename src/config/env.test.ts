import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

// The DBOS worker needs TWO distinct Postgres connection strings (design-delta
// §4): the APP db (`supagloo`, where workflows write domain rows via db-lib's
// Prisma client) and the DBOS SYSTEM db (`supagloo_dbos`, DBOS's own
// checkpoints/queues). This suite pins that split — the crux of "config parsing
// (system DB vs app DB URLs)".
const APP_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo";
const SYSTEM_URL = "postgres://supagloo:supagloo@localhost:5432/supagloo_dbos";

function validEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: APP_URL,
    DBOS_DATABASE_URL: SYSTEM_URL,
    ...overrides,
  };
}

/** Last path segment of a postgres URL = the database name. */
function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

describe("loadEnv", () => {
  it("accepts a valid env with distinct app + system database URLs", () => {
    const env = loadEnv(validEnv());
    expect(env.DATABASE_URL).toBe(APP_URL);
    expect(env.DBOS_DATABASE_URL).toBe(SYSTEM_URL);
    expect(env.NODE_ENV).toBe("development");
  });

  it("keeps the app db (supagloo) and the DBOS system db (supagloo_dbos) separate", () => {
    const env = loadEnv(validEnv());
    expect(env.DATABASE_URL).not.toBe(env.DBOS_DATABASE_URL);
    expect(dbNameOf(env.DATABASE_URL)).toBe("supagloo");
    expect(dbNameOf(env.DBOS_DATABASE_URL)).toBe("supagloo_dbos");
  });

  it("accepts the postgresql:// scheme for both and NODE_ENV=production", () => {
    const env = loadEnv(
      validEnv({
        DATABASE_URL: "postgresql://u:p@db:5432/app",
        DBOS_DATABASE_URL: "postgresql://u:p@db:5432/app_dbos",
        NODE_ENV: "production",
      }),
    );
    expect(env.DATABASE_URL).toBe("postgresql://u:p@db:5432/app");
    expect(env.DBOS_DATABASE_URL).toBe("postgresql://u:p@db:5432/app_dbos");
    expect(env.NODE_ENV).toBe("production");
  });

  it("rejects a missing app DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: undefined }))).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects an empty app DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DATABASE_URL: "" }))).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects a missing system DBOS_DATABASE_URL", () => {
    expect(() => loadEnv(validEnv({ DBOS_DATABASE_URL: undefined }))).toThrow(
      /DBOS_DATABASE_URL/,
    );
  });

  it("rejects a non-postgres app DATABASE_URL scheme", () => {
    expect(() =>
      loadEnv(validEnv({ DATABASE_URL: "http://example.com/db" })),
    ).toThrow(/postgres/i);
  });

  it("rejects a non-postgres system DBOS_DATABASE_URL scheme", () => {
    expect(() =>
      loadEnv(validEnv({ DBOS_DATABASE_URL: "mysql://nope/db" })),
    ).toThrow(/DBOS_DATABASE_URL/);
  });
});
