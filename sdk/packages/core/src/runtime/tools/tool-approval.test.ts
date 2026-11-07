import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolApprovalRequest } from "@cline/shared";
import { requestDesktopToolApproval } from "./tool-approval";

const request: ToolApprovalRequest = {
        sessionId: "session-123",
        agentId: "agent-123",
        conversationId: "conversation-123",
        iteration: 1,
        toolCallId: "call-123",
        toolName: "run_commands",
        input: { command: "Get-Content probe.txt" },
        policy: {} as ToolApprovalRequest["policy"],
};

const temporaryDirectories: string[] = [];

async function createApprovalDirectory(): Promise<{ root: string; approvalDir: string }> {
        const root = await mkdtemp(join(tmpdir(), "cline-tool-approval-"));
        temporaryDirectories.push(root);

        return {
                root,
                approvalDir: join(root, "approvals"),
        };
}

async function waitForRequestFile(approvalDir: string): Promise<void> {
        const requestFile = `${request.sessionId}.request.${request.toolCallId}.json`;

        await expect.poll(async () => {
                try {
                        await readFile(join(approvalDir, requestFile), "utf8");
                        return true;
                } catch {
                        return false;
                }
        }).toBe(true);
}

afterEach(async () => {
        await Promise.all(
                temporaryDirectories.splice(0).map((directory) =>
                        rm(directory, { recursive: true, force: true }),
                ),
        );
});

describe("requestDesktopToolApproval", () => {
        it("rejects a pre-aborted request without creating the approval directory", async () => {
                const { approvalDir } = await createApprovalDirectory();
                const controller = new AbortController();
                const reason = new Error("Already aborted");
                controller.abort(reason);

                await expect(
                        requestDesktopToolApproval(request, {
                                approvalDir,
                                sessionId: request.sessionId,
                                signal: controller.signal,
                        }),
                ).rejects.toBe(reason);

                await expect(readdir(approvalDir)).rejects.toMatchObject({
                        code: "ENOENT",
                });
        });

        it("removes the request file when aborted while waiting", async () => {
                const { approvalDir } = await createApprovalDirectory();
                const controller = new AbortController();
                const reason = new Error("User cancelled");

                const pending = requestDesktopToolApproval(request, {
                        approvalDir,
                        sessionId: request.sessionId,
                        signal: controller.signal,
                        pollIntervalMs: 10_000,
                });

                await waitForRequestFile(approvalDir);
                controller.abort(reason);

                await expect(pending).rejects.toBe(reason);
                expect(await readdir(approvalDir)).toEqual([]);
        });

        it("removes the request and decision files when aborted after a decision arrives", async () => {
                const { approvalDir } = await createApprovalDirectory();
                const controller = new AbortController();
                const reason = new Error("User cancelled");

                const pending = requestDesktopToolApproval(request, {
                        approvalDir,
                        sessionId: request.sessionId,
                        signal: controller.signal,
                        pollIntervalMs: 10_000,
                });

                await waitForRequestFile(approvalDir);

                const decisionFile = `${request.sessionId}.decision.${request.toolCallId}.json`;
                const decisionPath = join(approvalDir, decisionFile);
                await writeFile(decisionPath, JSON.stringify({ approved: true }), "utf8");

                controller.abort(reason);

                await expect(pending).rejects.toBe(reason);
                expect(await readdir(approvalDir)).toEqual([]);
                await expect(readFile(decisionPath, "utf8")).rejects.toMatchObject({
                        code: "ENOENT",
                });
        });

        it("consumes the request and decision files after a successful decision", async () => {
                const { approvalDir } = await createApprovalDirectory();

                const pending = requestDesktopToolApproval(request, {
                        approvalDir,
                        sessionId: request.sessionId,
                        pollIntervalMs: 10,
                });

                await waitForRequestFile(approvalDir);

                const decisionFile = `${request.sessionId}.decision.${request.toolCallId}.json`;
                await writeFile(
                        join(approvalDir, decisionFile),
                        JSON.stringify({ approved: true }),
                        "utf8",
                );

                await expect(pending).resolves.toEqual({ approved: true });
                expect(await readdir(approvalDir)).toEqual([]);
        });

        it("returns an explicit denial and consumes both approval files", async () => {
                const { approvalDir } = await createApprovalDirectory();

                const pending = requestDesktopToolApproval(request, {
                        approvalDir,
                        sessionId: request.sessionId,
                        pollIntervalMs: 5,
                });

                await waitForRequestFile(approvalDir);

                const decisionFile = `${request.sessionId}.decision.${request.toolCallId}.json`;
                await writeFile(
                        join(approvalDir, decisionFile),
                        JSON.stringify({ approved: false, reason: "Rejected by user" }),
                        "utf8",
                );

                await expect(pending).resolves.toEqual({
                        approved: false,
                        reason: "Rejected by user",
                });
                expect(await readdir(approvalDir)).toEqual([]);
        });

        it("ignores malformed decisions and times out without approving", async () => {
                const { approvalDir } = await createApprovalDirectory();

                const pending = requestDesktopToolApproval(request, {
                        approvalDir,
                        sessionId: request.sessionId,
                        timeoutMs: 1_000,
                        pollIntervalMs: 5,
                });

                await waitForRequestFile(approvalDir);

                const decisionFile = `${request.sessionId}.decision.${request.toolCallId}.json`;
                await writeFile(join(approvalDir, decisionFile), "{ invalid json", "utf8");

                await expect(pending).resolves.toEqual({
                        approved: false,
                        reason: "Tool approval request timed out",
                });
                expect(await readdir(approvalDir)).toEqual([]);
        });

        it("removes the request file when approval times out", async () => {
                const { approvalDir } = await createApprovalDirectory();

                const result = await requestDesktopToolApproval(request, {
                        approvalDir,
                        sessionId: request.sessionId,
                        timeoutMs: 30,
                        pollIntervalMs: 5,
                });

                expect(result).toEqual({
                        approved: false,
                        reason: "Tool approval request timed out",
                });
                expect(await readdir(approvalDir)).toEqual([]);
        });
});
