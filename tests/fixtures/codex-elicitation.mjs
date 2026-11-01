#!/usr/bin/env node
// New controlled stage 2b protocol fixture; unrelated to the old anpi run.
// No model, network, business operation, shell or native approval dialog.
import fs from "node:fs";
import readline from "node:readline";
let active;
const send = v => process.stdout.write(JSON.stringify(v) + "\n");
const done = () => send({ method: "turn/completed", params: { threadId: active.threadId,
  turn: { id: active.turnId, status: "completed", error: null, completedAt: 1, durationMs: 1,
    items: [{ type: "agentMessage", id: "fixture-message", text: "disposable fixture test passed", questions: null }] } } });
const ask = () => {
  const p = { serverName: "controlled-fixture", threadId: active.threadId, turnId: active.turnId, mode: "form",
    message: "Choose the disposable fixture change.", requestedSchema: { type: "object", properties: {
      choice: { type: "string", title: "Size", enum: ["Small", "Tiny"] },
      count: { type: "integer", minimum: 1, maximum: 2 }, confirm: { type: "boolean" },
    }, required: ["choice", "count", "confirm"] } };
  const mode = active.mode;
  if (mode === "URL") { p.mode = "url"; delete p.requestedSchema; p.url = "https://example.invalid/secret-path?credential=do-not-retain#secret"; p.elicitationId = "controlled-url-1"; }
  if (mode === "SECRET") p.requestedSchema.properties.choice = { type: "string", title: "Password", enum: ["Small"] };
  if (mode === "EXTRA_SCHEMA") p.requestedSchema.properties.count.multipleOf = 2;
  if (mode === "DEFAULT") p.requestedSchema.properties.count.default = 1;
  if (mode === "FREE_TEXT") p.requestedSchema.properties.choice = { type: "string" };
  if (mode === "OPENAI_FORM") p.mode = "openai/form";
  if (mode === "OPENAI_FORM_ALIAS") p.mode = "openaiForm";
  if (mode === "USER_VERIFICATION") {
    p.mode = "openai/userVerification"; delete p.message; delete p.requestedSchema;
    p.title = "Controlled device verification"; p.description = "Fixture device check only.";
    p.challenge = "never-retain-device-challenge";
  }
  if (mode === "OPTIONAL") p.requestedSchema.required = ["choice"];
  if (mode === "DUPLICATE_REQUIRED") p.requestedSchema = { type: "object", properties: { field: { type: "boolean" } }, required: ["field", "field"] };
  if (mode === "MANY_FIELDS") for (let i = 0; i < 9; i++) { p.requestedSchema.properties["field" + i] = { type: "boolean" }; p.requestedSchema.required.push("field" + i); }
  if (mode === "BAD_URL") { p.mode = "url"; p.url = 4; delete p.requestedSchema; }
  if (mode === "META") p._meta = { env: { API_KEY: "never-copy-this" } };
  if (mode === "MALFORMED") { delete p.serverName; p.mode = "unknown"; p.requestedSchema = { credentials: "never-copy-this" }; }
  if (mode === "WRONG_TURN") p.turnId = "unrelated";
  if (mode === "NULL_TURN") p.turnId = null;
  if (mode === "OVERSIZE") p.message = "x".repeat(17000);
  if (mode === "MISSING_ID") send({ method: "mcpServer/elicitation/request", params: p });
  else send({ id: `elicitation-${active.request ?? 1}`, method: mode === "UNKNOWN_METHOD" ? "mcpServer/elicitation/unknown" : "mcpServer/elicitation/request", params: p });
  if (mode === "DUPLICATE") send({ id: "elicitation-1", method: "mcpServer/elicitation/request", params: p });
  if (mode === "EXIT") setTimeout(() => process.exit(0), 100);
  if (mode === "UNSOLICITED_COMPLETE") setTimeout(done, 100);
  if (mode === "RESOLVED") setTimeout(() => send({ method: "serverRequest/resolved", params: { threadId: active.threadId, requestId: "elicitation-1" } }), 100);
};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  // Answers exist only in this disposable fixture log, never production evidence.
  fs.appendFileSync(new URL("./requests.jsonl", import.meta.url), JSON.stringify(m) + "\n");
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start") send({ id: m.id, result: { cwd: m.params.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: m.params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, thread: { id: "fixture-thread" } } });
  if (m.method === "turn/start") {
    active = { threadId: m.params.threadId, turnId: "fixture-turn", mode: m.params.input[0].text.split("\n").at(-1) };
    send({ id: m.id, result: { turn: { id: active.turnId, status: "inProgress", items: [] } } });
    if (active.mode === "STARTED_EVENT") send({ method: "turn/started", params: { threadId: active.threadId, turn: { id: active.turnId, status: "inProgress", items: [] } } });
    ask();
  }
  if (m.result?.action) {
    if (m.id !== `elicitation-${active.request ?? 1}`) process.exit(2);
    if (m.result.action === "accept") {
      const c = m.result.content;
      if (!["Small", "Tiny"].includes(c?.choice) || ![1, 2].includes(c?.count) || typeof c?.confirm !== "boolean") process.exit(3);
      const file = new URL("./workspace/disposable.txt", import.meta.url);
      fs.writeFileSync(file, c.choice + "\n");
      if (fs.readFileSync(file, "utf8") !== c.choice + "\n") process.exit(4);
    } else if (Object.hasOwn(m.result, "content")) process.exit(5);
    if (active.mode === "MULTIPLE" && !active.request) { active.request = 2; ask(); return; }
    setTimeout(done, 20);
  }
});
