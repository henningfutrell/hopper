// Sandbox steps: Windows sandbox steps (issue #731, design.md "Windows sandbox steps"), one step of a Linux job's work run
// on a Windows host over ssh, kept in the database and run by its saga (issue #1611); its log, exit code and outputs
// read back. The step script also asks for box steps (issue #1004) and need steps (issue #1007), each run in a sandbox
// of its own (src/sandbox/need-steps.ts).
export { createWindowsSteps, MASK, maskSecrets, NO_WINDOWS_STEPS, STEP_HOPPER_ENDED, STEP_INTERRUPTED, STEP_KEEP_MS, STEP_RERUN_NOTE, type StepAsk, type StepFields, type StepState, type WindowsStepLedger, type WindowsSteps, type WindowsStepsOptions } from './service.ts';
export { keptLog, STEP_LOG_LOST, withLostLog } from './step-log.ts';
export { WINDOWS_STEP_SAGA, windowsStepSaga } from './step-saga.ts';
export { createSshStepHost, type SshStepHostOptions } from './ssh-host.ts';
export { readWindowsHosts, windowsHostsView, writeWindowsHosts, type WindowsHostsWrite } from './hosts.ts';
export { BOX_SCRIPT_INPUT, BOX_STEP_HELP, STEP_HEADER, STEP_HELP, STEP_NOT_RUN, STEP_PATH, STEP_SCRIPT, STEP_SCRIPT_FILE, STEP_SCRIPT_INPUT, STEP_SCRIPT_VARIABLE } from './script.ts';
