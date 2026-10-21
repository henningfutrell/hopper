# hopper help

These pages tell you how the hopper works and how to use it, for the version you run. Each page is about one feature.

## The pages

- [Run and update the hopper](deploy-and-update.md)
- [Needs you: what waits on you](needs-you.md)
- [The main menu](navigation.md)
- [How issues become jobs](intake.md)
- [The Jobs view](jobs.md)
- [Lanes](lanes.md)
- [Questions and deciders](questions.md)
- [Research reports and proposals](research-and-proposals.md)
- [Pull requests](pull-requests.md)
- [Infra: plans and out-of-band changes](infra.md)
- [Resources: what the stack uses](resources.md)
- [The vault](vault.md)
- [Remote access](remote-access.md)
- [Sandbox boxes](sandboxes.md)
- [Artifacts](artifacts.md)
- [The operator CLI and the API](cli-and-api.md)
- [API tokens and grants](api-tokens.md)

## Where to read these pages

The hopper serves these pages itself. They always match the version that runs.

| Reader | Where |
|---|---|
| A person | `/help/` on the hopper's URL. In the UI, open the user menu and select **Help**. |
| An agent, by HTTP | `/help/index.json` lists every page. `/help/<page>.md` is the page as Markdown. |
| A job on a machine | `sh "$HOPPER_SKILL" help` lists the pages. `sh "$HOPPER_SKILL" help <page>` gives one page. |

The pages are Markdown files in the `help/` directory of the hopper's repository. Each reader reads the same files.

## More to read

- The API reference: `/docs/` on the hopper's URL.
- Deep deploy reference: [docs/deploy.md](https://github.com/henningfutrell/hopper/blob/dev/docs/deploy.md).
- Sign-in and roles: [docs/sign-in.md](https://github.com/henningfutrell/hopper/blob/dev/docs/sign-in.md).
- Plugins: [docs/plugins.md](https://github.com/henningfutrell/hopper/blob/dev/docs/plugins.md).
- The event log and webhooks: [docs/events.md](https://github.com/henningfutrell/hopper/blob/dev/docs/events.md).
- Connect an outside agent to the hopper: [docs/agent-integration.md](https://github.com/henningfutrell/hopper/blob/dev/docs/agent-integration.md).
- The user guide on the project site: [guide](https://henningfutrell.github.io/hopper/guide.html).
