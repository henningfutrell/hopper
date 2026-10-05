// Users (issue #158, design.md "Users: one hopper, separate users"): one person the hopper works for,
// with everything of theirs kept apart from every other user's.

/** A user, as the instance schema's `users` row holds it. */
export interface User {
  /** `owner`, or a slug of the name: names the user schema, the work dir and the secret prefix. */
  id: string;
  /** Unique among the users. */
  name: string;
  createdAt: string;
  /** The user work dir, relative to HOPPER_WORK_DIR: '' for `owner`, `users/<id>` for a user added later. */
  workDir: string;
  /** What the user's secret names start with: '' for `owner`, `HOPPER_USER_<ID>_` for a user added later. */
  secretPrefix: string;
}

/** The first user of every hopper: an install from before several users holds its work. */
export const OWNER_ID = 'owner';

/** GET /api/users: who the users are, nothing of their own data. */
export interface UserView {
  id: string;
  name: string;
  createdAt: string;
}

/** POST /ui/api/users `add`: the new user and a one-time login link for it per UI origin (none when local sign-in is off). */
export interface UserAdded {
  user: UserView;
  links: string[];
}
