// Report a bug (issue #694, design.md "Report a bug").
export { maskReportText, REPORT_LABEL, REPORT_REPO, reportBody, reportContext, reportTitle, searchTerms, similarityOf, type ReportSystem, type ReportText } from './context.ts';
export { createReportGitHub, ReportGitHubError, type ReportGitHub, type SimilarReport } from './github.ts';
export { BugReportRefused, createBugReports, MAX_SIMILAR, sendLater, SIMILAR_AT, type BugReportAnswer, type BugReportDraft, type BugReports, type BugReportsOptions, type JobReport } from './service.ts';
export { createReportSender, REPORT_SEND_MS, sendReport, type ReportSender } from './later.ts';
