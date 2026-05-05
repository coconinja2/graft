"use strict";
/**
 * Claude Code hook handlers for Graft.
 *
 * preToolUse  — claim the target resource; deliver pending signals.
 * postToolUse — refresh TTL for writes; release for reads.
 *
 * These are invoked by the `graft hook pre` and `graft hook post` CLI commands,
 * which are wired into Claude Code via .claude/settings.json.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.handlePreToolUse = handlePreToolUse;
exports.handlePostToolUse = handlePostToolUse;
const path = __importStar(require("path"));
const client_1 = require("../../sdk/client");
const WRITE_TOOLS = new Set(['Write', 'Edit', 'Bash', 'NotebookEdit']);
async function ensureBusRunning(busUrl) {
    try {
        await fetch(`${busUrl}/health`, { signal: AbortSignal.timeout(500) });
        return;
    }
    catch {
        // Bus not reachable — start it as a background daemon
        const { spawn } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const cliPath = path.resolve(__dirname, '../../cli/index.js');
        spawn(process.execPath, [cliPath, 'start'], { detached: true, stdio: 'ignore' }).unref();
        // Wait up to 2.5s for the bus to bind
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 250));
            try {
                await fetch(`${busUrl}/health`, { signal: AbortSignal.timeout(200) });
                return;
            }
            catch { /* still starting */ }
        }
    }
}
const READ_TOOLS = new Set(['Read']);
function extractResource(toolName, toolInput) {
    switch (toolName) {
        case 'Write':
        case 'Read':
            return toolInput.file_path ?? null;
        case 'Edit':
            return toolInput.file_path ?? null;
        case 'NotebookEdit':
            return toolInput.notebook_path ?? null;
        case 'Bash': {
            // Best-effort: extract first file-like token from the command
            const cmd = toolInput.command;
            if (!cmd)
                return null;
            const match = cmd.match(/(?:^|\s)([\w./\-]+\.\w+)/);
            return match ? match[1] : null;
        }
        default:
            return null;
    }
}
async function handlePreToolUse(input) {
    const { toolName, toolInput, agentId, busUrl } = input;
    const client = new client_1.GraftClient({ busUrl, agentId });
    await ensureBusRunning(client.busUrl).catch(() => { });
    // Ensure this agent has a signal queue. Idempotent — safe to call every hook.
    // Subscribing here means agent B automatically receives change_summary signals
    // from agent A even if B was blocked and moved on to other work.
    await client.subscribe(['change_summary', 'interface_change', 'schema_change', 'security_finding', 'new_utility', 'resource_conflict']).catch(() => { });
    // Always deliver pending signals, regardless of whether we claim
    let signalContext = '';
    try {
        const signals = await client.getPendingSignals();
        if (signals.length > 0) {
            const formatted = signals.map(s => {
                const lines = [`  [${s.type}] from ${s.from}: ${s.message}`];
                if (s.affectedResources?.length) {
                    lines.push(`    affected: ${s.affectedResources.join(', ')}`);
                }
                if (s.changeContext) {
                    lines.push(`    what: ${s.changeContext.what}`);
                    if (s.changeContext.why)
                        lines.push(`    why: ${s.changeContext.why}`);
                    if (s.changeContext.breakingChange)
                        lines.push(`    breaking: yes`);
                    if (s.changeContext.diff)
                        lines.push(`    diff:\n${s.changeContext.diff.split('\n').map(l => `      ${l}`).join('\n')}`);
                }
                return lines.join('\n');
            });
            signalContext =
                '\n\nChanges broadcast by other agents — review and decide how to proceed:\n' +
                    formatted.join('\n') +
                    '\n\nIf any of these changes affect what you are currently working on, incorporate them before continuing. If they are unrelated to your current task, continue as planned.';
        }
    }
    catch {
        // Bus unreachable — fail open
    }
    if (!WRITE_TOOLS.has(toolName)) {
        if (signalContext) {
            return { proceed: true, message: signalContext.trim() };
        }
        return { proceed: true };
    }
    const resourceId = extractResource(toolName, toolInput);
    if (!resourceId) {
        return { proceed: true, message: signalContext.trim() || undefined };
    }
    try {
        const result = await client.claim({ resourceId, intent: `${toolName} on ${resourceId}` });
        if (result.granted) {
            const lines = [`Graft: claimed ${resourceId}`];
            if (signalContext)
                lines.push(signalContext.trim());
            return { proceed: true, message: lines.join('\n') };
        }
        const holder = result.holder;
        const message = [
            `Graft has blocked this tool call. Another agent (${holder.agentId}) currently holds an exclusive write claim on this resource.`,
            `Holder intent: "${holder.intent}"`,
            `Conflict ID: ${result.conflictId}`,
            `This is not a file or tool error — it is a coordination signal. Do not retry. Either work on something else or let the user know you are waiting.`,
            signalContext,
        ]
            .filter(Boolean)
            .join('\n');
        return { proceed: false, message };
    }
    catch {
        // Bus unreachable — fail open
        return { proceed: true, message: signalContext.trim() || undefined };
    }
}
async function handlePostToolUse(input) {
    const { toolName, toolInput, toolOutput, agentId, busUrl, changeSummary } = input;
    const client = new client_1.GraftClient({ busUrl, agentId });
    const resourceId = extractResource(toolName, toolInput);
    if (!resourceId)
        return { broadcasted: false };
    try {
        if (READ_TOOLS.has(toolName)) {
            await client.release(resourceId);
            return { broadcasted: false };
        }
        if (WRITE_TOOLS.has(toolName)) {
            const payload = changeSummary ?? {
                what: `${agentId} modified ${resourceId}`,
                why: 'No summary provided — inspect the file for details.',
                breakingChange: false,
                affectedResources: [resourceId],
                diff: typeof toolOutput?.patch === 'string' ? toolOutput.patch : undefined,
            };
            await Promise.all([
                client.heartbeat(resourceId).catch(() => { }),
                client.publish({
                    type: 'change_summary',
                    message: payload.what,
                    affectedResources: payload.affectedResources,
                    severity: payload.breakingChange ? 'high' : 'low',
                    changeContext: payload,
                }).catch(() => { }),
            ]);
            return { broadcasted: true, message: `Graft: released ${resourceId} — change_summary broadcast to other agents` };
        }
    }
    catch {
        // Bus unreachable — fail open
    }
    return { broadcasted: false };
}
//# sourceMappingURL=hooks.js.map