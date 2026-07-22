import { afterEach, describe, it, expect } from "vitest";
import {
  clearProviderConfig,
  getProviderConfig,
  setProviderConfig,
} from "./config";

// Process-scoped provider config injected once by runtime.ts before DBOS.launch()
// (mirrors scaffold-project/config.ts + app-db.ts). Steps read it via
// getProviderConfig() instead of touching process.env; it holds the two provider
// base URLs + the secrets encryption key the credential-load step decrypts with.

afterEach(() => clearProviderConfig());

describe("provider config singleton", () => {
  it("throws a clear error when read before it is set", () => {
    clearProviderConfig();
    expect(() => getProviderConfig()).toThrow(/not initialized/i);
  });

  it("round-trips set → get", () => {
    setProviderConfig({
      openrouterBaseUrl: "https://openrouter.ai",
      glooBaseUrl: "https://platform.ai.gloo.com",
      secretsEncryptionKey: "a".repeat(64),
    });
    const cfg = getProviderConfig();
    expect(cfg.openrouterBaseUrl).toBe("https://openrouter.ai");
    expect(cfg.glooBaseUrl).toBe("https://platform.ai.gloo.com");
    expect(cfg.secretsEncryptionKey).toBe("a".repeat(64));
  });

  it("clear() resets it back to the uninitialized state", () => {
    setProviderConfig({
      openrouterBaseUrl: "https://openrouter.ai",
      glooBaseUrl: "https://platform.ai.gloo.com",
      secretsEncryptionKey: "a".repeat(64),
    });
    clearProviderConfig();
    expect(() => getProviderConfig()).toThrow();
  });
});
