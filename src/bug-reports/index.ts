// Report a bug (issue #694, design.md "Report a bug").
export { maskReportText, MAX_REPORT_DESCRIPTION, MAX_REPORT_TITLE, PUBLIC_REPORT_WARNING, REPORT_LABEL, REPORT_REPO, reportBody, reportContext, reportTitle, searchTerms, similarityOf, type ReportSystem, type ReportText } from './context.ts';
export { createReportGitHub, ReportGitHubError, type ReportGitHub, type SimilarReport } from './github.ts';
export { scrubIdentifiers } from './identifiers.ts';
export { APPROVAL_PROBLEM, BugReportRefused, createBugReports, MAX_SIMILAR, REPORTS_OFF, type ReportPreview, sendLater, SIMILAR_AT, type BugReportAnswer, type BugReportDraft, type BugReports, type BugReportsOptions, type JobReport, type JobReportAnswer } from './service.ts';
export { createReportSender, REPORT_SEND_MS, sendReport, type ReportSender } from './later.ts';
export { commitCandidates, privateWorkOf, privateWorkOfEvents, scrubPrivateWork, type HopperOwn, type PrivateWork, type RemovedKind, type Scrubbed } from './private-work.ts';
