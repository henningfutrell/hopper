// Pending approvals (issue #2088, design.md "Pending approvals").
export { createApprovalsGitHub, type ApprovalsGitHub } from './github.ts';
export { createPendingApprovals, FRESH_MS, TICK_MS, type ApprovalsSource, type PendingApprovals, type PendingApprovalsOptions } from './service.ts';
