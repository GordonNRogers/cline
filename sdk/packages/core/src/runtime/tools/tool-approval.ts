import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";

export type DesktopToolApprovalOptions = {
	approvalDir?: string;
	sessionId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	pollIntervalMs?: number;
	nowIso?: () => string;
};

function sanitizeApprovalToken(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error(
		typeof signal.reason === "string" ? signal.reason : "Tool approval aborted",
	);
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	throwIfAborted(signal);

	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => finish(resolve), ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const finish = (complete: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			complete();
		};
		const onAbort = () => finish(() => reject(abortError(signal)));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// Best-effort cleanup.
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

export async function requestDesktopToolApproval(
	request: ToolApprovalRequest,
	options: DesktopToolApprovalOptions = {},
): Promise<ToolApprovalResult> {
	const signal = options.signal;
	throwIfAborted(signal);

	const approvalDir = options.approvalDir?.trim();
	const sessionId = options.sessionId?.trim();
	if (!approvalDir || !sessionId) {
		return { approved: false, reason: "Desktop tool approval IPC is not configured" };
	}

	const requestId = sanitizeApprovalToken(`${request.toolCallId}`);
	const requestPath = join(approvalDir, `${sessionId}.request.${requestId}.json`);
	const decisionPath = join(approvalDir, `${sessionId}.decision.${requestId}.json`);
	const nowIso = options.nowIso ?? (() => new Date().toISOString());

	await mkdir(approvalDir, { recursive: true });
	throwIfAborted(signal);

	try {
		await writeFile(
			requestPath,
			`${JSON.stringify(
					{
						requestId,
						sessionId,
						createdAt: nowIso(),
						toolCallId: request.toolCallId,
						toolName: request.toolName,
						input: request.input,
						iteration: request.iteration,
						agentId: request.agentId,
						conversationId: request.conversationId,
					},
					null,
					2,
			)}\n`,
			"utf8",
		);
		throwIfAborted(signal);
	} catch (error) {
		if (signal?.aborted) {
			await unlinkIfPresent(requestPath);
			throw abortError(signal);
		}
		throw error;
	}

	const timeoutMs = options.timeoutMs ?? 5 * 60_000;
	const pollIntervalMs = options.pollIntervalMs ?? 200;
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		throwIfAborted(signal);
		try {
			const raw = await readFile(decisionPath, "utf8");
			const parsed = JSON.parse(raw) as { approved?: boolean; reason?: string };
			throwIfAborted(signal);
			const result = {
				approved: parsed.approved === true,
				reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
			};
			await Promise.all([
				unlinkIfPresent(decisionPath),
				unlinkIfPresent(requestPath),
			]);
			return result;
		} catch (error) {
			if (signal?.aborted) {
				await unlinkIfPresent(requestPath);
				throw abortError(signal);
			}
			if (!isNotFound(error) && !(error instanceof SyntaxError)) throw error;
			// The decision has not arrived yet, or is still being written.
		}
		try {
			await delay(pollIntervalMs, signal);
		} catch (error) {
			await unlinkIfPresent(requestPath);
			throw error;
		}
	}

	throwIfAborted(signal);
	await unlinkIfPresent(requestPath);
	return { approved: false, reason: "Tool approval request timed out" };
}
