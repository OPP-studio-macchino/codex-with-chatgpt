import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import { notificationFile, noticeCategorySchema } from "./delivery-store.js";
import { checkPrivateParents, readPrivateFile, syncPrivateDirectory } from "../security/stable-file.js";
import type { NotificationOutcome } from "../execution/extensions.js";
import type { LocalRunNotice } from "./local-sound.js";
import { nativeHelperCommand, type NativeHelperCommand } from "../workspace/registration-native.js";

const noticeSchema = z.object({
  workspace_id: z.string().regex(/^[a-f0-9]{24}$/),
  task_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  run_id: z.string().regex(/^[a-f0-9]{32}$/),
  state: z.enum(["completed", "blocked", "failed"]),
  notification_id: z.string().regex(/^[a-f0-9]{64}$/).length(64),
  category: noticeCategorySchema,
}).strict();

// Fixed source and bundle identity. The private data file contains only validated IDs/state.
const SWIFT_SOURCE = String.raw`import AppKit
import Foundation
import Darwin
struct Notice: Decodable {
    let workspace_id: String
    let task_id: String
    let run_id: String
    let state: String
    let notification_id: String
    let category: String
}
func matches(_ value: String, _ pattern: String) -> Bool {
    return value.range(of: pattern, options: .regularExpression) == (value.startIndex..<value.endIndex)
}
func reply(_ status: String) {
    let data = try! JSONSerialization.data(withJSONObject: ["status": status])
    FileHandle.standardOutput.write(data)
}
let url = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("notice.json")
guard CommandLine.arguments.count == 2,
      let file = try? FileHandle(forReadingFrom: url),
      let data = try? file.read(upToCount: 2049), data.count <= 2048,
      let notice = try? JSONDecoder().decode(Notice.self, from: data),
      matches(notice.workspace_id, "^[a-f0-9]{24}$"),
      matches(notice.task_id, "^[A-Za-z0-9_.:-]{1,128}$"),
      matches(notice.run_id, "^[a-f0-9]{32}$"),
      matches(notice.notification_id, "^[a-f0-9]{64}$"),
      ["completed", "blocked", "failed", "approval_required", "user_input_required", "mcp_elicitation_required", "decision_owner_attention"].contains(notice.category),
      ["completed", "blocked", "failed"].contains(notice.state) else {
    reply("failed")
    exit(1)
}
try? file.close()
// This path is derived internally by C2C, never accepted from MCP/notice input.
// Keep the inode: unlinking a flock file could allow two live same-ID windows.
let receiptPath = CommandLine.arguments[1]
guard receiptPath.hasPrefix("/"), URL(fileURLWithPath: receiptPath).lastPathComponent == notice.notification_id + ".native",
      URL(fileURLWithPath: receiptPath).deletingLastPathComponent().lastPathComponent == "notification-delivery" else { exit(1) }
var parent = URL(fileURLWithPath: receiptPath).deletingLastPathComponent()
let receiptParent = parent.path
while true {
    var st = stat()
    guard lstat(parent.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR,
          parent.path != receiptParent || (st.st_uid == getuid() && (st.st_mode & 0o077) == 0) else { exit(1) }
    if parent.path == "/" { break }
    parent.deleteLastPathComponent()
}
let receiptFD = open(receiptPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
var receiptStat = stat(), namedStat = stat()
guard receiptFD >= 0, fstat(receiptFD, &receiptStat) == 0, lstat(receiptPath, &namedStat) == 0,
      (receiptStat.st_mode & S_IFMT) == S_IFREG, receiptStat.st_uid == getuid(),
      (receiptStat.st_mode & 0o077) == 0, receiptStat.st_nlink == 1, receiptStat.st_size == 0,
      receiptStat.st_ino == namedStat.st_ino, receiptStat.st_dev == namedStat.st_dev else { exit(1) }
guard flock(receiptFD, LOCK_EX | LOCK_NB) == 0 else { reply("already_open"); exit(0) }
// The lock inode is permanent; the separate click receipt is replaced atomically.
let ackPath = receiptPath + ".ack"
let acknowledgedReceipt = Data(("acknowledged:" + notice.notification_id).utf8)
let ackFD = open(ackPath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
if ackFD >= 0 {
    var st = stat(), named = stat()
    guard fstat(ackFD, &st) == 0, lstat(ackPath, &named) == 0,
          (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid(), (st.st_mode & 0o077) == 0,
          st.st_nlink == 1, st.st_size <= 128, st.st_ino == named.st_ino, st.st_dev == named.st_dev,
          let previous = try? FileHandle(fileDescriptor: ackFD).read(upToCount: 129), previous == acknowledgedReceipt else { exit(1) }
    reply("acknowledged"); exit(0)
} else if errno != ENOENT { exit(1) }
let bridgePID = getppid()
guard bridgePID > 1 else { exit(1) }
let attention = notice.state != "completed"
let app = NSApplication.shared
app.setActivationPolicy(attention ? .regular : .accessory)
app.finishLaunching()
final class NoticePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
final class Acknowledgement: NSObject {
    @objc func clicked(_ sender: NSButton) {
        // A click acknowledges this notice only. Persist before replying or closing.
        let temporary = ackPath + "." + UUID().uuidString + ".tmp"
        do {
            let fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw NSError(domain: "receipt", code: 1) }
            let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
            try file.write(contentsOf: acknowledgedReceipt)
            guard fsync(fd) == 0, rename(temporary, ackPath) == 0 else { throw NSError(domain: "receipt", code: 1) }
            let directoryFD = open(receiptParent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard directoryFD >= 0 else { throw NSError(domain: "receipt", code: 2) }
            let synced = fsync(directoryFD); close(directoryFD)
            guard synced == 0 else { throw NSError(domain: "receipt", code: 3) }
            reply("acknowledged")
        } catch { unlink(temporary); reply("failed") }
        NSApplication.shared.terminate(nil)
    }
}
let panel = NoticePanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 420),
    styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
panel.title = "C2C"
panel.level = .statusBar
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.hidesOnDeactivate = false
panel.isReleasedWhenClosed = false
panel.backgroundColor = attention ? NSColor.windowBackgroundColor : NSColor.controlBackgroundColor
let content = panel.contentView!
let title = NSTextField(labelWithString: attention ? "C2C — 確認が必要です" : "C2C — 実行が完了しました")
title.font = NSFont.boldSystemFont(ofSize: 26)
title.textColor = attention ? NSColor.systemOrange : NSColor.labelColor
title.frame = NSRect(x: 28, y: 354, width: 584, height: 40)
content.addSubview(title)
let next = attention
    ? "ChatGPTでC2Cの進捗を確認してください。\n「確認した」でこの通知を閉じます。作業の再開には別途操作が必要です。"
    : "ChatGPTでC2Cの実行結果を確認してください。確認した操作は承認・再開・目標達成の確認ではありません。"
let stateLabel = notice.state == "completed" ? "実行完了" : notice.state == "blocked" ? "停止中" : "実行失敗"
let details = NSTextField(wrappingLabelWithString:
    "状態: \(stateLabel) (\(notice.category))\nワークスペース: \(notice.workspace_id)\nタスク: \(notice.task_id)\n実行: \(notice.run_id)\n\n\(next)")
details.font = NSFont.systemFont(ofSize: 15)
details.frame = NSRect(x: 28, y: 72, width: 584, height: 270)
content.addSubview(details)
let acknowledgement = Acknowledgement()
let button = NSButton(title: "確認した", target: acknowledgement, action: #selector(Acknowledgement.clicked(_:)))
button.bezelStyle = .rounded
button.keyEquivalent = ""
button.isEnabled = false
button.frame = NSRect(x: 470, y: 20, width: 142, height: 36)
content.addSubview(button)
// Prevent a click already in progress from acknowledging a newly appeared notice.
Timer.scheduledTimer(withTimeInterval: 0.75, repeats: false) { _ in button.isEnabled = true }
// SIGKILL/crash of the bridge cannot leave a persistent orphan. A restart contender
// holds off on the same flock until this process closes; no duplicate live notice.
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    if getppid() != bridgePID { app.terminate(nil) }
}
guard getppid() == bridgePID else { exit(1) }
panel.center()
panel.orderFrontRegardless()
if attention { app.requestUserAttention(.informationalRequest) }
app.run()
panel.orderOut(nil)
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>tech.opp-studio.c2c.run-notice</string>
<key>CFBundleName</key><string>C2C Run Notice</string>
<key>CFBundleExecutable</key><string>C2CRunNotice</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`;

/** Every notice persists until acknowledgement; this wait never authorizes task operations. */
export async function executeRunNotice(notice: LocalRunNotice, invoke: NativeHelperCommand = nativeHelperCommand, signal = new AbortController().signal): Promise<NotificationOutcome> {
  let dir: string | undefined;
  let running = false;
  let outcome: NotificationOutcome;
  try {
    const safe = noticeSchema.parse({ workspace_id: notice.workspace_id, task_id: notice.task_id, run_id: notice.run_id, state: notice.state, notification_id: notice.notification_id, category: notice.category });
    // Regex '$' also matches before a final newline; IDs must contain no line breaks.
    if (Object.values(safe).some(value => /[\r\n]/.test(value))) throw new Error("Invalid notice ID");
    const receipt = notificationFile(safe.notification_id, true);
    const lock = readPrivateFile(receipt, 0);
    if (lock !== null && lock !== "") throw new Error("Invalid notice lock");
    const existing = readPrivateFile(receipt + ".ack", 128);
    if (existing !== null) {
      if (existing !== "acknowledged:" + safe.notification_id) throw new Error("Invalid notice receipt");
      return { outcome: "notice_acknowledged" };
    }
    checkPrivateParents(receipt);
    await fs.mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
    checkPrivateParents(receipt);
    syncPrivateDirectory(path.dirname(path.dirname(receipt)));
    signal.throwIfAborted();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-run-notice-"));
    await fs.chmod(dir, 0o700);
    const source = path.join(dir, "main.swift");
    const bundle = path.join(dir, "C2C Run Notice.app");
    const contents = path.join(bundle, "Contents");
    const helper = path.join(contents, "MacOS", "C2CRunNotice");
    await fs.writeFile(source, SWIFT_SOURCE, { mode: 0o600, flag: "wx" });
    await fs.writeFile(path.join(dir, "notice.json"), JSON.stringify(safe), { mode: 0o600, flag: "wx" });
    await fs.mkdir(path.dirname(helper), { recursive: true });
    await fs.writeFile(path.join(contents, "Info.plist"), INFO_PLIST, { mode: 0o600, flag: "wx" });
    await invoke("/usr/bin/xcrun", ["swiftc", "-framework", "AppKit", source, "-o", helper], 15_000, signal);
    await invoke("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "tech.opp-studio.c2c.run-notice", bundle], 15_000, signal);
    running = true;
    const output = await invoke(helper, [receipt], 0, signal);
    // Exit zero, expiry, malformed replies and approval-like replies are never acknowledgement.
    outcome = Buffer.byteLength(output) <= 1024 && output.trim() === '{"status":"acknowledged"}' &&
      readPrivateFile(receipt + ".ack", 128) === "acknowledged:" + safe.notification_id
      ? { outcome: "notice_acknowledged" } : { outcome: "process_exit", exit_code: 0 };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    outcome = running && typeof code === "number" && Number.isInteger(code) ? { outcome: "process_exit", exit_code: code }
      : (error as { killed?: boolean })?.killed || code === "ETIMEDOUT" ? { outcome: "timeout" } : { outcome: "process_error" };
  } finally {
    if (dir) {
      try { await fs.rm(dir, { recursive: true, force: true }); }
      catch { /* Preserve the observed outcome; never claim successful cleanup. */ }
    }
  }
  return outcome;
}
