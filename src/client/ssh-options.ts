// The ssh options every connection between the hopper and a target carries (design.md "Target
// authentication", issue #59), on the command line so they beat any config: public-key
// authentication only, the one key given only, pinned host keys only, nothing forwarded. One owner:
// the hopper's connections to ssh targets (src/executors/ssh.ts) and a client's tunnel to the hopper
// (tunnel.ts) both use this list. Imports nothing: it is installed on client targets as a plain file.
export const HARDENED_SSH_OPTIONS: readonly string[] = [
  'BatchMode=yes', 'ConnectTimeout=10',
  // Public-key authentication only.
  'PreferredAuthentications=publickey', 'PubkeyAuthentication=yes', 'PasswordAuthentication=no',
  'KbdInteractiveAuthentication=no', 'GSSAPIAuthentication=no', 'HostbasedAuthentication=no',
  // The one key given only.
  'IdentitiesOnly=yes', 'IdentityAgent=none',
  // Pinned host keys only.
  'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null', 'UpdateHostKeys=no', 'CheckHostIP=no', 'VerifyHostKeyDNS=no',
  // Nothing forwarded, nothing run here.
  'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'RequestTTY=no',
];
