import { ProviderHttpError } from "./errors";

/**
 * Gloo OAuth2 client-credentials token mint (design-delta §2.5/§7). Exchanges the
 * user's clientId/secret for a short-lived (~1h) bearer token used for a SINGLE
 * generateObject call and never persisted (minted fresh per run). HTTP Basic
 * `clientId:clientSecret`, form body `grant_type=client_credentials&scope=api/access`
 * — the exact contract verified against the live provider in
 * supagloo-nextjs/lib/gloo/llm-client.ts.
 *
 * Injectable `fetch`, closures over the base URL — mirrors the api-side clients.
 */

export interface MintGlooTokenArgs {
  /** e.g. `https://platform.ai.gloo.com` (the `/oauth2/token` path is appended). */
  glooBaseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

export interface GlooToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");

export async function mintGlooToken(args: MintGlooTokenArgs): Promise<GlooToken> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const basic = Buffer.from(`${args.clientId}:${args.clientSecret}`).toString(
    "base64",
  );

  const res = await fetchImpl(`${trimSlash(args.glooBaseUrl)}/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "api/access",
    }),
  });

  if (!res.ok) {
    throw new ProviderHttpError(
      `Gloo token mint failed: ${res.status}`,
      res.status,
      await res.text().catch(() => undefined),
    );
  }

  const body = (await res.json()) as {
    access_token: string;
    token_type?: string;
    expires_in?: number;
  };
  return {
    accessToken: body.access_token,
    tokenType: body.token_type ?? "Bearer",
    expiresIn: body.expires_in ?? 0,
  };
}
