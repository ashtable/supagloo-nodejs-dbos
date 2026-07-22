import { describe, it, expect } from "vitest";
import { ProviderHttpError } from "./errors";
import { mintGlooToken } from "./gloo";

// Gloo mints a short-lived (~1h) bearer token per run via the OAuth2
// client-credentials grant (HTTP Basic clientId:secret, form body
// `grant_type=client_credentials&scope=api/access`). Confirmed against the real
// provider in supagloo-nextjs/lib/gloo/llm-client.ts. The token is used for a
// single generateObject call and never persisted. Injected fetch, hand-built
// Response — no mocking library.

interface Captured {
  url: string;
  method?: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

function capturingFetch(
  captured: Captured[],
  response: Response,
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(url),
      method: init?.method,
      authorization: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body: String(init?.body ?? ""),
    });
    return response;
  }) as unknown as typeof fetch;
}

describe("mintGlooToken", () => {
  it("POSTs the client-credentials grant with Basic auth + scope, returns the parsed token", async () => {
    const captured: Captured[] = [];
    const fetchImpl = capturingFetch(
      captured,
      new Response(
        JSON.stringify({
          access_token: "gloo_stub_1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "api",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const token = await mintGlooToken({
      glooBaseUrl: "https://platform.ai.gloo.com",
      clientId: "cid",
      clientSecret: "csecret",
      fetchImpl,
    });

    expect(token.accessToken).toBe("gloo_stub_1");
    expect(token.tokenType).toBe("Bearer");
    expect(token.expiresIn).toBe(3600);

    const req = captured[0];
    expect(req.url).toBe("https://platform.ai.gloo.com/oauth2/token");
    expect(req.method).toBe("POST");
    expect(req.authorization).toBe(
      `Basic ${Buffer.from("cid:csecret").toString("base64")}`,
    );
    expect(req.contentType).toContain("application/x-www-form-urlencoded");
    const form = new URLSearchParams(req.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("api/access");
  });

  it("trims a trailing slash on the base URL", async () => {
    const captured: Captured[] = [];
    const fetchImpl = capturingFetch(
      captured,
      new Response(
        JSON.stringify({ access_token: "t", token_type: "Bearer", expires_in: 1 }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await mintGlooToken({
      glooBaseUrl: "https://platform.ai.gloo.com/",
      clientId: "c",
      clientSecret: "s",
      fetchImpl,
    });
    expect(captured[0].url).toBe("https://platform.ai.gloo.com/oauth2/token");
  });

  it("surfaces a non-2xx as a typed ProviderHttpError carrying the status", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 401,
      })) as unknown as typeof fetch;

    await expect(
      mintGlooToken({
        glooBaseUrl: "https://platform.ai.gloo.com",
        clientId: "bad",
        clientSecret: "bad",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ name: "ProviderHttpError", status: 401 });
  });
});
