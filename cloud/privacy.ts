// hopper.io's privacy note (issue #463, docs/hopper-io-security.md R5): each field hopper.io collects, why, and for how
// long, one line per column of its store. test/cloud/privacy.test.ts holds it to the store's columns, so a new column
// is a new line here in the same change. Served at /privacy.

export interface PrivacyField { table: string; column: string; what: string; why: string; kept: string }

const ACCOUNT = 'Until you delete your hopper.io account.';
const SESSION = 'Until you sign out, or for 7 days.';
const SIGN_IN = 'Until you come back from GitHub, or for 10 minutes.';
const RECORD = 'For 90 days, or until you delete your hopper.io account.';
const REGISTRATION = 'Until you remove the instance or unlink it on the instance, it is registered under another account, or you delete your hopper.io account.';
const REGISTRATION_NAME = 'Until you change it, or as long as the registration.';
const TOMBSTONE = 'For 90 days after the removal or the deletion of the account.';
const MIGRATION = 'As long as hopper.io runs. It is about hopper.io, not about you.';

export const PRIVACY_NOTE: PrivacyField[] = [
  { table: 'account', column: 'github_user_id', what: 'Your GitHub account number.', why: 'It is the key of your hopper.io account. A login can change, this number does not.', kept: ACCOUNT },
  { table: 'account', column: 'login', what: 'Your GitHub login.', why: 'To show who is signed in.', kept: ACCOUNT },
  { table: 'account', column: 'avatar_url', what: 'The address of your GitHub avatar.', why: 'To show your avatar when you are signed in.', kept: ACCOUNT },
  { table: 'account', column: 'created_at', what: 'When you first signed in.', why: 'To show the age of the account.', kept: ACCOUNT },
  { table: 'account', column: 'seen_at', what: 'When you last signed in.', why: 'To show when the account was last used.', kept: ACCOUNT },
  { table: 'session', column: 'token_hash', what: 'A hash of your session cookie, never the cookie itself.', why: 'To know that your browser is signed in.', kept: SESSION },
  { table: 'session', column: 'account_id', what: 'The account of the session.', why: 'To know who the session is.', kept: SESSION },
  { table: 'session', column: 'created_at', what: 'When the session started.', why: 'To end sessions on time.', kept: SESSION },
  { table: 'session', column: 'expires_at', what: 'When the session ends.', why: 'To end sessions on time.', kept: SESSION },
  { table: 'sign_in', column: 'state_hash', what: 'A hash of a random value of one sign-in at GitHub.', why: 'So only the browser that started a sign-in can finish it.', kept: SIGN_IN },
  { table: 'sign_in', column: 'verifier', what: 'A random value of one sign-in at GitHub (PKCE).', why: 'GitHub asks for it to finish the sign-in.', kept: SIGN_IN },
  { table: 'sign_in', column: 'created_at', what: 'When the sign-in started.', why: 'To refuse a sign-in that is too old.', kept: SIGN_IN },
  { table: 'sign_in', column: 'deletes', what: 'The account a deletion is to delete.', why: 'To delete only the account you confirm at GitHub.', kept: SIGN_IN },
  { table: 'record', column: 'id', what: 'A number for each record.', why: 'To show records in order.', kept: RECORD },
  { table: 'record', column: 'account_id', what: 'The account the record is about.', why: 'To show you only your own records.', kept: RECORD },
  { table: 'record', column: 'kind', what: 'What was done: a sign-in, a sign-out, a deletion confirmed as another GitHub account, or an instance registered, named, removed, unlinked or registered under another account.', why: 'So you can see what was done on your account.', kept: RECORD },
  { table: 'record', column: 'at', what: 'When it was done.', why: 'So you can see when it was done.', kept: RECORD },
  { table: 'registration', column: 'account_id', what: 'The account that registered a hopper instance.', why: 'To show you only your own instances.', kept: REGISTRATION },
  { table: 'registration', column: 'install_id', what: 'The id of a hopper instance you registered: random, made by the instance. It names no person and no machine.', why: 'To know the instance again when it registers or connects.', kept: REGISTRATION },
  { table: 'registration', column: 'created_at', what: 'When you registered the instance.', why: 'To show when the instance was registered.', kept: REGISTRATION },
  { table: 'registration', column: 'name', what: 'The name you gave the instance at hopper.io, if any. The instance does not send it.', why: 'To show you which instance is which.', kept: REGISTRATION_NAME },
  { table: 'registration', column: 'seen_at', what: 'When the instance last connected to hopper.io.', why: 'To show you whether the instance still connects.', kept: REGISTRATION },
  { table: 'registration_tombstone', column: 'install_id', what: 'The id of an instance you removed, or of a deleted account. Nothing of the account.', why: 'hopper.io cannot reach an instance, so it tells the instance at its next connection that its registration is gone.', kept: TOMBSTONE },
  { table: 'registration_tombstone', column: 'removed_at', what: 'When the instance was removed, or the account deleted.', why: 'To delete the tombstone after 90 days.', kept: TOMBSTONE },
  { table: 'cloud_migration', column: 'version', what: 'Which changes to its tables hopper.io made.', why: 'To make each change once.', kept: MIGRATION },
  { table: 'cloud_migration', column: 'applied_at', what: 'When hopper.io made each change.', why: 'To find faults.', kept: MIGRATION },
];

/** What hopper.io never keeps, said on the page. */
export const NEVER_KEPT = [
  'No GitHub token. hopper.io uses the token of a sign-in once, to read who you are, and drops it.',
  'No IP address in its database. The sign-in limit counts sign-ins per address in memory, for one minute only.',
  'No browser details, no logs of requests, and no data of other people.',
  'No content of your hopper instances or their jobs.',
];
