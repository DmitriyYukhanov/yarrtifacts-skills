/** Types for deny-artifact-core.mjs — kept next to the implementation so the product repo's
 *  strict-TS tests can import the exact file the public plugin ships. */

export const ALLOW_ENV: "YARRTIFACTS_ALLOW_BUILTIN_ARTIFACT";
export const DENY_REASON: string;

export interface HookDenyOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/** null means "emit nothing and let the tool call proceed". */
export function decide(payload: unknown, env?: Record<string, string | undefined>): HookDenyOutput | null;
