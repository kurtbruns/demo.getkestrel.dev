/**
 * No network egress from a sandbox (DESIGN.md, "Sends"). Every outbound request Kestrel can
 * make goes through the global `fetch`: Resend's API, SES through aws4fetch, SNS signing
 * certificates and subscription URLs, Access's JWKS. Replacing it with one that refuses means
 * none of them can leave, whatever a visitor does, even on a code path the fake transport
 * never takes. It's isolate-wide, which is fine: the Worker itself reaches its sandboxes and
 * R2 through bindings, never the global fetch.
 */

export const egress = {
  /** Outbound requests refused in this isolate. */
  refused: 0,
  /** The last URL refused, for the log line and the tests. */
  lastUrl: "",
};

function refuse(input: RequestInfo | URL): never {
  const url = input instanceof Request ? input.url : String(input);
  egress.refused += 1;
  egress.lastUrl = url;
  throw new Error(`outbound network access is disabled in the demo sandbox (${url})`);
}

let installed = false;

/** Replace the global `fetch` with one that refuses every request. Idempotent. */
export function blockEgress(): void {
  if (installed) {
    return;
  }
  installed = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => refuse(input)) as typeof fetch;
}
