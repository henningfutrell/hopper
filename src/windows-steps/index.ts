// Sandbox steps: Windows sandbox steps (issue #731, design.md "Windows sandbox steps"), one step of a Linux job's work run
// on a Windows host over ssh, and box steps (issue #1004, design.md "Box steps"), one step run in a sandbox box the job's
// own sandbox request started; its output streamed back, its exit code and outputs returned.
export { createWindowsSteps, MASK, maskSecrets, STEP_KEEP_MS, type StepBoxes, type StepFields, type StepStart, type WindowsSteps, type WindowsStepsOptions } from './service.ts';
export { createSshStepHost, type SshStepHostOptions } from './ssh-host.ts';
export { readWindowsHosts, windowsHostsView, writeWindowsHosts, type WindowsHostsWrite } from './hosts.ts';
export { BOX_SCRIPT_INPUT, BOX_STEP_HELP, STEP_HEADER, STEP_HELP, STEP_NOT_RUN, STEP_PATH, STEP_SCRIPT, STEP_SCRIPT_FILE, STEP_SCRIPT_INPUT, STEP_SCRIPT_VARIABLE } from './script.ts';
