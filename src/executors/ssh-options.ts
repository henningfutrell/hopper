// The ssh options every connection between the hopper and a target carries (design.md "Target
// authentication", issue #59), on the command line so they beat any config: public-key
// authentication only, the one key given only, pinned host keys only, nothing forwarded: the hopper's
// connections to ssh targets (ssh.ts).
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
