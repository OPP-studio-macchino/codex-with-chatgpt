#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "skill", "SKILL.md");
const source = fs.readFileSync(file, "utf8");

if (Buffer.byteLength(source, "utf8") > 128 * 1024) throw new Error("SKILL.md exceeds 128 KiB");
const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
if (!match) throw new Error("SKILL.md must begin with YAML frontmatter");

const frontmatter = new Map();
for (const line of match[1].split("\n")) {
  if (!line.trim()) continue;
  const field = line.match(/^([a-z-]+):\s*(.*)$/);
  if (!field) throw new Error(`Unsupported frontmatter syntax: ${line}`);
  if (frontmatter.has(field[1])) throw new Error(`Duplicate frontmatter key: ${field[1]}`);
  frontmatter.set(field[1], field[2].trim());
}

const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
for (const key of frontmatter.keys()) {
  if (!allowed.has(key)) throw new Error(`Unexpected frontmatter key: ${key}`);
}
const name = frontmatter.get("name") ?? "";
const description = frontmatter.get("description") ?? "";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
  throw new Error("Skill name must be hyphen-case and no longer than 64 characters");
}
if (!description || description.length > 1024 || /[<>]/.test(description)) {
  throw new Error("Skill description is missing or invalid");
}
if (/\[TODO:/i.test(source)) throw new Error("SKILL.md contains an unfinished TODO marker");

const requiredBoundaries = [
  "explicitly asks",
  "separate consent gates",
  "requested source excerpts",
  "Do not install software",
  "Never print, paste, log",
  "Never represent a local check",
];
for (const boundary of requiredBoundaries) {
  if (!source.includes(boundary)) throw new Error(`SKILL.md is missing consent boundary: ${boundary}`);
}

process.stdout.write("Skill structure and consent boundaries are valid.\n");
