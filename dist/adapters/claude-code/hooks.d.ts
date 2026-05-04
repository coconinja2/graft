/**
 * Claude Code hook handlers for Graft.
 *
 * preToolUse  — claim the target resource; deliver pending signals.
 * postToolUse — refresh TTL for writes; release for reads.
 *
 * These are invoked by the `graft hook pre` and `graft hook post` CLI commands,
 * which are wired into Claude Code via .claude/settings.json.
 */
import type { ChangeSummaryPayload } from '../../bus/signals';
export interface PreHookInput {
    toolName: string;
    toolInput: Record<string, unknown>;
    agentId: string;
    busUrl?: string;
}
export interface PreHookOutput {
    proceed: boolean;
    message?: string;
}
export declare function handlePreToolUse(input: PreHookInput): Promise<PreHookOutput>;
export interface PostHookInput {
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput?: Record<string, unknown>;
    agentId: string;
    busUrl?: string;
    changeSummary?: ChangeSummaryPayload;
}
export interface PostHookOutput {
    broadcasted: boolean;
    message?: string;
    warning?: string;
}
export declare function handlePostToolUse(input: PostHookInput): Promise<PostHookOutput>;
//# sourceMappingURL=hooks.d.ts.map