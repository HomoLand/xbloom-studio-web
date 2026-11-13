import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { api } from "../api.ts";
import { getAccountCredentials, saveAccountSession } from "./accountPrefs.ts";
import { cloudRequest, loginEphemeral, syncAccountCatalog, fetchCloudBrewRecords } from "./xbloomCloud.ts";

afterEach(() => mock.restoreAll());

const account = {
  configured: true, email: "me@example.test", region: "china" as const,
  languageType: 1, session: { hostSession: "saved-reference", memberId: 42 },
};

test("new tabs use the host account without a browser password or bearer token", async () => {
  mock.method(api, "accountStatus", async () => account);
  const requests: Array<{ endpoint: string; form: Record<string, unknown> }> = [];
  mock.method(api, "accountRequest", async (endpoint, form) => {
    requests.push({ endpoint, form });
    return { result: "success", list: [] };
  });
  const credentials = await getAccountCredentials();
  assert.equal(credentials?.password, "");
  assert.equal(credentials?.email, account.email);
  await syncAccountCatalog({ ...credentials!, include: ["created"] });
  await fetchCloudBrewRecords(credentials!);
  assert.deepEqual(requests.map(r => r.endpoint), ["tuMyTeaRecipeCreated.tuhtml", "tuBrewRecordList.tuhtml"]);
  for (const request of requests) {
    assert.equal(request.form.hostSession, account.session.hostSession);
    assert.ok(!("token" in request.form));
    assert.ok(!("password" in request.form));
  }
});

test("host login uses the existing CSRF-aware API and stores no browser password", async () => {
  let submitted: unknown;
  mock.method(api, "accountLogin", async (input) => { submitted = input; return account; });
  const result = await saveAccountSession({ email: account.email, password: "one-use-password", region: "china" });
  assert.equal((submitted as { password: string }).password, "one-use-password");
  assert.equal(result.password, "");
  assert.equal(result.languageType, 1);
});

test("signed-out host cannot fall back to stale tab credentials", async () => {
  mock.method(api, "accountStatus", async () => ({ configured: false }));
  assert.equal(await getAccountCredentials(), null);
  await assert.rejects(loginEphemeral({email: account.email, password: "old", region: "china"}), /login required/);
});

test("cloud operations preserve host errors and never fall back to direct requests", async () => {
  mock.method(api, "accountRequest", async () => { throw new Error("host account changed"); });
  await assert.rejects(cloudRequest("https://unused.example/", "tuRecipeAdd.tuhtml", account.session), /host account changed/);
});
