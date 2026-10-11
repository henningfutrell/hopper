// The GitHub issue thread as a job source's thread (issue #435, design.md "The hopper label means full automation"): a
// question goes onto the issue as one comment under the source's identity — the user's account, or the app's bot — and
// its replies are the issue's comments. A post is done once: a comment that already carries the question's marker (a
// post whose record was lost to a crash) is answered in place of a second one. The post answers the comment it made, so
// nothing waits on the listing to show it.
import { threadMarker, threadQuestionComment, type SourceThread } from '../../domain/thread-ask.ts';
import type { GitHubApi } from './api.ts';

export function gitHubThread(api: GitHubApi): SourceThread {
  const posted = async (repo: string, number: number, questionId: string) => {
    const marker = threadMarker(questionId);
    const c = (await api.listComments(repo, number)).find((x) => x.body.trimStart().startsWith(marker));
    return c && { commentId: c.id, url: c.url };
  };
  return {
    async ask(repo, number, questionId, text) {
      const before = await posted(repo, number, questionId);
      if (before) return before;
      const made = await api.postComment(repo, number, threadQuestionComment(questionId, text));
      if (made.id > 0) return { commentId: made.id, url: made.url };
      // GitHub did not say which comment it made: the listing does.
      const listed = await posted(repo, number, questionId);
      if (!listed) throw new Error(`the question comment on ${repo}#${number} cannot be found after it was posted`);
      return listed;
    },
    async comments(repo, number) {
      return (await api.listComments(repo, number)).map((c) => ({ id: c.id, author: c.author, body: c.body, url: c.url, ...(c.association ? { association: c.association } : {}) }));
    },
  };
}
