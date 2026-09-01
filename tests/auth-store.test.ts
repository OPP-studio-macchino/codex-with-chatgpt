import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AuthStore, filterScopes, invalidScopes } from "../src/auth/store.js";
import { isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;

beforeEach(() => {
  stateDir = isolateStateDir();
});

describe("OAuth authorization store", () => {
  it("defaults to least privilege and rejects unknown scope names", () => {
    expect(filterScopes(undefined)).toEqual(["workspace.read"]);
    expect(filterScopes("workspace.read unknown.scope")).toEqual(["workspace.read"]);
    expect(invalidScopes("workspace.read unknown.scope")).toEqual(["unknown.scope"]);
  });

  it("does not persist a client until pairing authorization succeeds", () => {
    const file = path.join(makeTmpDir("auth-store"), "auth.json");
    const store = new AuthStore("workspace-auth", { file });
    const client = store.registerClient({
      clientName: "ChatGPT",
      redirectUris: ["https://example.com/callback"],
    });
    expect(fs.existsSync(file)).toBe(false);
    store.markClientAuthorized(client.clientId);
    const persisted = fs.readFileSync(file, "utf8");
    expect(persisted).toContain(client.clientId);
  });

  it("bounds unauthenticated provisional registrations", () => {
    const file = path.join(stateDir, "auth-limit.json");
    const store = new AuthStore("workspace-limit", { file });
    const clients = [];
    for (let index = 0; index < 8; index++) {
      clients.push(store.registerClient({ redirectUris: [`https://example.com/callback/${index}`] }));
    }
    expect(() =>
      store.registerClient({ redirectUris: ["https://attacker-over-cap.example/callback"] })
    ).toThrow("PROVISIONAL_CLIENT_LIMIT");
    expect(store.getClient(clients[0].clientId)).toBeDefined();
  });

  it("enforces redirect validation inside the store boundary", () => {
    const store = new AuthStore("workspace-redirect", { file: path.join(stateDir, "redirect.json") });
    expect(() =>
      store.registerClient({ redirectUris: ["https://user:password@example.com/callback"] })
    ).toThrow("INVALID_REDIRECT_URIS");
    expect(() =>
      store.registerClient({ redirectUris: ["https://example.com/callback#fragment"] })
    ).toThrow("INVALID_REDIRECT_URIS");
  });

  it("unpairing clears both tokens and client registrations", () => {
    const file = path.join(stateDir, "auth-revoke.json");
    const store = new AuthStore("workspace-revoke", { file });
    const client = store.registerClient({ redirectUris: ["https://example.com/callback"] });
    store.markClientAuthorized(client.clientId);
    store.issueTokens({ clientId: client.clientId, scopes: ["workspace.read"] });
    expect(store.revokeAll()).toBe(1);
    expect(store.getClient(client.clientId)).toBeUndefined();
    expect(store.tokenCount()).toBe(0);
  });

  it("refuses unsupported scopes at token issuance", () => {
    const store = new AuthStore("workspace-scope", { file: path.join(stateDir, "scope.json") });
    expect(() => store.issueTokens({ clientId: "test", scopes: ["admin.write"] })).toThrow(
      /Unsupported OAuth scope/
    );
  });

  it("drops persisted clients whose redirect URIs fail the current policy", () => {
    const file = path.join(stateDir, "auth-migration.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        clients: [
          {
            clientId: "c2c_client_abcdefghijkl",
            redirectUris: ["https://user:password@example.com/callback"],
            createdAt: new Date().toISOString(),
          },
        ],
        tokens: [],
      })
    );
    const store = new AuthStore("workspace-migration", { file });
    expect(store.getClient("c2c_client_abcdefghijkl")).toBeUndefined();
  });

  it("sanitizes control and bidi characters in client labels", () => {
    const file = path.join(stateDir, "auth-label.json");
    const store = new AuthStore("workspace-label", { file });
    const client = store.registerClient({
      clientName: "Trusted\u202e\nClient",
      redirectUris: ["https://example.com/callback"],
    });
    expect(client.clientName).toBe("Trusted Client");
  });
});
