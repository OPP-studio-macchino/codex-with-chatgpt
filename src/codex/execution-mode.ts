import { z } from "zod/v3";

/** A local sandbox restriction; existing workspace admission and scopes still apply. */
export const executionModeSchema = z.enum(["read_only", "workspace_write"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export function executionSandbox(mode: ExecutionMode) {
  executionModeSchema.parse(mode);
  return mode === "read_only"
    ? { type: "readOnly" as const, networkAccess: false }
    : { type: "workspaceWrite" as const, writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}
