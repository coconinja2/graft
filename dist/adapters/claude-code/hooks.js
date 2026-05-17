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
const fs = __importStar(require("fs"));
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
        case 'Read': {
            const filePath = toolInput.file_path;
            return filePath ? { resourceId: filePath } : null;
        }
        case 'Edit': {
            const filePath = toolInput.file_path;
            if (!filePath)
                return null;
            const oldString = toolInput.old_string;
            const lineRange = oldString ? resolveLineRange(filePath, oldString) : undefined;
            return { resourceId: filePath, lineRange };
        }
        case 'NotebookEdit': {
            const notebookPath = toolInput.notebook_path;
            return notebookPath ? { resourceId: notebookPath } : null;
        }
        case 'Bash': {
            const cmd = toolInput.command;
            if (!cmd)
                return null;
            const match = cmd.match(/(?:^|\s)([\w./\-]+\.\w+)/);
            return match ? { resourceId: match[1] } : null;
        }
        default:
            return null;
    }
}
// Read the file before the edit executes and locate old_string to compute its line range.
// Returns undefined when the file doesn't exist, old_string isn't found, or it appears
// more than once (ambiguous — fall back to whole-file claim).
function resolveLineRange(filePath, oldString) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const idx = content.indexOf(oldString);
        if (idx === -1)
            return undefined;
        if (content.indexOf(oldString, idx + 1) !== -1)
            return undefined; // multiple matches
        const lineStart = content.slice(0, idx).split('\n').length;
        const lineEnd = lineStart + oldString.split('\n').length - 1;
        return { start: lineStart, end: lineEnd };
    }
    catch {
        return undefined;
    }
}
async function handlePreToolUse(input) {
    const { toolName, toolInput, agentId, busUrl } = input;
    const client = new client_1.GraftClient({ busUrl, agentId });
    await ensureBusRunning(client.busUrl).catch(() => { });
    // Ensure this agent has a signal queue. Idempotent — safe to call every hook.
    // Subscribing here means agent B automatically receives change_summary signals
    // from agent A even if B was blocked and moved on to other work.
    await (client.subscribe?.(['change_summary', 'interface_change', 'schema_change', 'security_finding', 'new_utility', 'resource_conflict']) ?? Promise.resolve()).catch(() => { });
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
    const resource = extractResource(toolName, toolInput);
    if (!resource) {
        return { proceed: true, message: signalContext.trim() || undefined };
    }
    const { resourceId, lineRange } = resource;
    const rangeDesc = lineRange ? ` lines ${lineRange.start}–${lineRange.end}` : '';
    try {
        const result = await client.claim({ resourceId, lineStart: lineRange?.start, lineEnd: lineRange?.end, intent: `${toolName} on ${resourceId}${rangeDesc}` });
        if (result.granted) {
            if (signalContext)
                return { proceed: true, message: signalContext.trim() };
            return { proceed: true };
        }
        const holder = result.holder;
        const holderRange = holder.lineRange ? ` (lines ${holder.lineRange.start}–${holder.lineRange.end})` : '';
        const message = [
            `Graft has blocked this tool call. Another agent (${holder.agentId}) holds an exclusive write claim on ${resourceId}${holderRange}.`,
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
    const { toolName, toolInput, agentId, busUrl, changeSummary } = input;
    const client = new client_1.GraftClient({ busUrl, agentId });
    const resource = extractResource(toolName, toolInput);
    if (!resource)
        return { broadcasted: false };
    const { resourceId } = resource;
    try {
        if (READ_TOOLS.has(toolName)) {
            await client.release(resourceId);
            return { broadcasted: false };
        }
        if (WRITE_TOOLS.has(toolName)) {
            await client.heartbeat(resourceId).catch(() => { });
            if (!changeSummary) {
                return {
                    broadcasted: false,
                    warning: `change_summary not broadcast — no changeSummary provided to postToolUse hook for ${resourceId}. Pass a changeSummary with what/why/breakingChange/affectedResources.`,
                };
            }
            await client.publish({
                type: 'change_summary',
                message: changeSummary.what,
                affectedResources: changeSummary.affectedResources,
                severity: changeSummary.breakingChange ? 'high' : 'low',
                changeContext: changeSummary,
            }).catch(() => { });
            return { broadcasted: true };
        }
    }
    catch {
        // Bus unreachable — fail open
    }
    return { broadcasted: false };
}
//# sourceMappingURL=hooks.js.map