#!/usr/bin/env node
// Deterministic fixture only. Never invokes Codex, a shell, or an external API.
import fs from "node:fs";
import readline from "node:readline";
let thread = 0, turn = 0, active;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const done = (status = "completed") => send({ method: "turn/completed", params: {
  threadId: active.threadId, turn: { id: active.turnId, status, items: [{ type: "agentMessage", text: "fixture done" }] },
} });
const question = id => ({ id, header: "Choice", question: "Choose\u001b\u202e a mode: sk-abcdefghijklmnop123456", isSecret: false,
  isOther: true, options: [{ label: "Small", description: "Bounded work" }] });
const ask = (id = "rpc-1") => {
  const params = { threadId: active.threadId, turnId: active.turnId, itemId: "item-1", questions: [question("choice")] };
  const mode = active.mode;
  if (mode !== "LEGACY") params.isBlocking = mode === "NONBLOCKING" ? false : true;
  if (mode === "BLOCKING_FLAG") params.isBlocking = "true";
  if (mode === "UNKNOWN_KEY") params.unknown = true;
  if (mode.startsWith("DEADLINE:")) params.autoResolutionMs = JSON.parse(mode.slice(9));
  if (mode === "MULTI") params.questions.push(question("second"));
  if (mode === "SECRET") params.questions[0].isSecret = true;
  if (mode === "FLAG") params.questions[0].isOther = "yes";
  if (mode === "PROTOTYPE") params.questions[0].id = "__proto__";
  if (mode === "DUPLICATE_QUESTION") params.questions.push(question("choice"));
  if (mode === "MANY") params.questions = Array.from({length: 5}, (_, i) => question("q" + i));
  if (mode === "OVERSIZE") params.questions[0].question = "x".repeat(2049);
  if (mode === "OPTIONS") params.questions[0].options.push(params.questions[0].options[0]);
  if (mode === "WRONG_THREAD") params.threadId = "unrelated";
  if (mode === "WRONG_TURN" || mode === "EARLY_WRONG") params.turnId = "unrelated";
  send({ id: mode === "BAD_RPC" ? {} : id, method: "item/tool/requestUserInput", params });
};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  fs.appendFileSync(new URL("./requests.jsonl", import.meta.url), JSON.stringify(m) + "\n");
  if (m.method === "initialize") send({ id: m.id, result: {} });
  else if (m.method === "thread/start") send({ id: m.id, result: { cwd: m.params.cwd, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: m.params.sandbox === "read-only" ? { type: "readOnly", networkAccess: false } : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }, thread: { id: "thread-" + ++thread } } });
  else if (m.method === "turn/start") {
    active = { threadId: m.params.threadId, turnId: "turn-" + ++turn, mode: m.params.input[0].text.split("\n").at(-1) };
    const started = () => send({ id: m.id, result: { turn: { id: active.turnId } } });
    if (active.mode.startsWith("EARLY")) { ask(); setTimeout(started, 30); return; }
    started();
    if (active.mode === "COMPLETE") { done(); return; }
    if (active.mode.startsWith("APPROVAL:")) {
      send({ id: "approval", method: active.mode.slice(9), params: {} }); return;
    }
    ask(active.mode === "NUMBER_RPC" ? 99 : "rpc-1");
    if (active.mode === "DUPLICATE_RPC") ask();
    if (active.mode === "EXIT") setTimeout(() => process.exit(0), 80);
    if (active.mode === "INTERRUPT") setTimeout(() => done("interrupted"), 80);
    if (active.mode === "RESOLVED") setTimeout(() => send({ method: "serverRequest/resolved", params: {
      threadId: active.threadId, requestId: "rpc-1",
    } }), 80);
  } else if (m.result?.answers) {
    const expected = active.mode === "NUMBER_RPC" ? 99 : "rpc-1";
    if (m.id !== expected && !(active.mode === "TWICE" && m.id === "rpc-2")) process.exit(2);
    if (active.mode === "TWICE" && m.id === "rpc-1") { ask("rpc-2"); return; }
    done();
  }
});
