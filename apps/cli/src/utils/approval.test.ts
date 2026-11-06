import { afterEach, describe, expect, it, vi } from "vitest";
import type {
    ToolApprovalContext,
    ToolApprovalRequest,
    ToolApprovalResult,
} from "@cline/shared";

const coreMock = vi.hoisted(() => ({
    requestDesktopToolApproval: vi.fn(),
}));

const originalMode = process.env.CLINE_TOOL_APPROVAL_MODE;
const originalApprovalDir = process.env.CLINE_TOOL_APPROVAL_DIR;

afterEach(() => {
    vi.doUnmock("@cline/core");
    vi.resetModules();
    vi.clearAllMocks();

    if (originalMode === undefined) {
        delete process.env.CLINE_TOOL_APPROVAL_MODE;
    } else {
        process.env.CLINE_TOOL_APPROVAL_MODE = originalMode;
    }

    if (originalApprovalDir === undefined) {
        delete process.env.CLINE_TOOL_APPROVAL_DIR;
    } else {
        process.env.CLINE_TOOL_APPROVAL_DIR = originalApprovalDir;
    }
});

async function loadApprovalModule() {
    vi.resetModules();
    vi.doMock("@cline/core", () => coreMock);

    process.env.CLINE_TOOL_APPROVAL_MODE = "desktop";
    process.env.CLINE_TOOL_APPROVAL_DIR = "test-approval-dir";

    return import("./approval");
}

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

describe("requestToolApproval desktop adapter", () => {
    it("forwards the abort signal to core", async () => {
        const result: ToolApprovalResult = { approved: true };
        coreMock.requestDesktopToolApproval.mockResolvedValue(result);

        const { requestToolApproval } = await loadApprovalModule();
        const controller = new AbortController();
        const context: ToolApprovalContext = { signal: controller.signal };

        await expect(requestToolApproval(request, context)).resolves.toEqual(result);

        expect(coreMock.requestDesktopToolApproval).toHaveBeenCalledWith(request, {
            approvalDir: "test-approval-dir",
            sessionId: request.sessionId,
            signal: controller.signal,
        });
    });

    it("supports calls without an approval context", async () => {
        coreMock.requestDesktopToolApproval.mockResolvedValue({ approved: false });

        const { requestToolApproval } = await loadApprovalModule();

        await expect(requestToolApproval(request)).resolves.toEqual({
            approved: false,
        });

        expect(coreMock.requestDesktopToolApproval).toHaveBeenCalledWith(request, {
            approvalDir: "test-approval-dir",
            sessionId: request.sessionId,
            signal: undefined,
        });
    });
});
