import type { ToolApprovalContext, ToolApprovalRequest, ToolApprovalResult } from "@cline/shared";
import type { ToolExecutors } from "../../extensions/tools";

export interface RuntimeCapabilities {
	toolExecutors?: Partial<ToolExecutors>;
	requestToolApproval?: (
		request: ToolApprovalRequest,
		context?: ToolApprovalContext,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
}
