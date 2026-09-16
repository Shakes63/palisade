# Welcome Contributors!

We like commits as they keep the project going. If you have ideas you want to experiment with, make a fork and see how it works. Open pull requests if you are unsure and suggest changes to our maintainers.

- [Welcome Contributors!](#welcome-contributors)
  - [Our Philosophy](#our-philosophy)
  - [Contributing Code](#contributing-code)
    - [Development Process](#development-process)
    - [Local Setup](#local-setup)
    - [Before You Open a Pull Request](#before-you-open-a-pull-request)
    - [Commit Message Guidelines](#commit-message-guidelines)
    - [Structuring Commits](#structuring-commits)
    - [Pull Request Title Guidelines](#pull-request-title-guidelines)
  - [Adding Support for a Game](#adding-support-for-a-game)
  - [Contributing Documentation](#contributing-documentation)
    - [Working with Documentation Source Files](#working-with-documentation-source-files)
    - [Submitting Changes](#submitting-changes)
    - [Manual of Style](#manual-of-style)
  - [Communication](#communication)

## Our Philosophy

- Update docs with the code.
- Content is King, consistency is Queen.
- Do not assume that readers know everything you currently know.
- Avoid jargon and acronyms, if you can.
- Do not reference future development or features that do not yet exist.

## Contributing Code

### Development Process

Pull requests should be created from personal forks. We follow a fork and rebase workflow.

> The concept of a fork originated with GitHub, it is not a Git concept. If you are new to forks, see [About forks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/about-forks) and [Contributing Guide when you fork a repository](https://medium.com/@rishabhmittal200/contributing-guide-when-you-fork-a-repository-3b97657b01fb).

### Local Setup

You need Node 20+, [pnpm](https://pnpm.io) 9, and a working Docker daemon.

```bash
pnpm install                     # install the workspace
cp .env.example apps/api/.env    # never commit a real .env
sed -i '/^DOCKER_HOST=/d' apps/api/.env   # see below
pnpm db:generate                 # generate the Prisma client
pnpm --filter @ark/api db:push   # create the dev SQLite database
pnpm dev                         # API on :8787, web UI on :3000
```

The API and the Prisma CLI both run with `apps/api` as their working directory, so that is
where `dotenv` and `prisma` look. A `.env` in the repo root is ignored by `pnpm dev` without
any warning. You can leave `SECRETS_KEY` and `JWT_SECRET` blank for local work: the API
generates them on first start and persists them to `data/.secrets.json`.

Drop `DOCKER_HOST` from that copy, as above. The example file points it at
`tcp://socket-proxy:2375`, a hostname that only resolves inside Compose, so every Docker call
in `pnpm dev` fails. Unset, it defaults to the host's `unix:///var/run/docker.sock`, which is
what you want locally, and what Compose uses regardless of the file.

To run the whole manager the way users do, bring it up with Compose. It reads its own `.env`
in the repo root, and needs `SECRETS_KEY` and `JWT_SECRET` filled in there - the example file
leaves both blank:

```bash
cp .env.example .env    # the root copy, read by Compose

# two separate values — each command prints one 64-character hex string,
# ready to paste into .env
node -e "console.log('SECRETS_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('JWT_SECRET='  + require('crypto').randomBytes(32).toString('hex'))"

docker compose up --build
```

### Before You Open a Pull Request

Run the same gate CI runs. A change that skips it fails in CI instead:

```bash
pnpm db:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The default test suite fakes Docker so it never touches your daemon. The integration suite
runs against a real one and must be opted into explicitly:

```bash
PALISADE_DOCKER_TESTS=1 pnpm --filter @ark/api test:docker
```

Bug fixes and new behaviour should come with a test. If the behaviour depends on how the
Docker daemon actually responds, write a `*.docker.test.ts` — the fake has been wrong before.

### Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) format for commit messages. Use the same `type(scope): description` format for the subject line.

Rules for the full commit message:

1. Separate the subject from the body with a blank line.
2. Use the imperative (commanding) mood in the subject line, and keep it to 75 characters.
3. Do not capitalise the first word of the description, and do not end the subject with a period.
4. Describe the change, not the issue behind it.
5. Wrap the body at 75 characters as well.
6. Use the body to explain **what** and **why** vs. how, and say whether any interface changed.
7. Keep it as short as the change allows. One short paragraph is the normal body; it _can_ run to several when a change genuinely needs them, but treat that as the exception rather than the target. Omit the body only when the change is genuinely self-explanatory, and never list files, restate the diff, or pad the message with narration.

Example:

```
fix(rcon): reconnect after a container restart

The client held the socket from the container's previous run, so every
command after a restart failed until the manager itself was restarted.
It now reconnects when the container id changes.
```

### Structuring Commits

Each commit is one atomic logical change:

- The tree must build and pass the gate at that commit.
- Reverting it must not break the commits around it.
- It should do one thing. A change to the Docker layer and an unrelated UI tweak are two commits.

Fold review fixes and typo corrections into the commit they fix (`git commit --fixup` plus
`git rebase --autosquash`) rather than leaving them in the history as separate commits. Do
not go the other way either: a branch that genuinely does several separable things stays
several commits.

Pull requests are squash-merged, so **your branch's individual commit messages do not survive
the merge — the pull request title becomes the commit message on its own.** Write the title
so it stands alone as the permanent record of the change: it must be a valid commit summary
under the rules above, not a label like "fixes" or "address review". Anything a future reader
needs beyond that one line belongs in the pull request description, which is what a reviewer
reads and what we copy into the commit body when the change warrants one.

The 75-character wrap applies to the commit message body only. A pull request description is
rendered as Markdown in a browser, so write it in normal unwrapped paragraphs and let it
reflow — hard-wrapping it just makes it awkward to read and to edit. Rewrap it if and when it
becomes a commit body.

The practical consequence is that the unit of history here is the pull request, so keep one
pull request to one logical change. A branch doing two separable things should be two pull
requests, or it lands as a single commit that cannot be reverted independently.

Keep your branch current with `git pull --rebase` rather than merging `main` into it; merge
commits make the diff under review harder to read even though they disappear in the squash.

> **Note on history:** most commits before this convention was adopted do not carry a type
> prefix, and are written as plain capitalised sentences. That is the old style, not a second
> accepted one — follow the rules above for anything new, and do not treat the old messages
> as a model for length or tone either.

### Pull Request Title Guidelines

A pull request title becomes the squashed commit's message, so it is held to the same rules
as a commit summary — it just gets a little more room, since it has to describe the whole
branch rather than one commit of it.
Titles follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<optional scope>): <description>
```

**Allowed types:**

| Type       | Use for                                  |
| ---------- | ---------------------------------------- |
| `feat`     | New feature or capability                |
| `fix`      | Bug fix                                  |
| `docs`     | Documentation only changes               |
| `refactor` | Code change that is not a fix or feature |
| `test`     | Adding or updating tests                 |
| `chore`    | Maintenance tasks                        |
| `ci`       | CI/CD configuration changes              |
| `revert`   | Reverting a previous commit              |
| `build`    | Build system or tooling changes          |

**Rules:**

- `scope` is optional, lowercase, no spaces (e.g. `rcon`, `backups`, `scheduler`, `palworld`)
- `description`: imperative mood, no capital first letter, no trailing period
- Total title length must not exceed 75 characters

**Examples:**

```
fix(rcon): reconnect after a container restart
feat(valheim): browse Thunderstore mods in app
docs: update the supported game table
refactor(backups): share the archive writer across games
chore(deps): update the itzg minecraft image
```

For real-world examples of well-named pull requests, see the [conventionalcommits.org pull requests](https://github.com/conventional-commits/conventionalcommits.org/pulls).

---

## Adding Support for a Game

New games are very welcome, but a game is never one file. Pick an existing game close to the
one you are adding and grep its enum value (for example `grep -rl CORE_KEEPER apps packages`)
— that list is your checklist. It usually covers:

- `packages/shared/src/game.ts` — the `Game` enum entry, its label, and version pinning.
- `apps/api/src/catalog/<game>.catalog.ts` plus registration in `catalog.service.ts`.
- `common/naming.ts` (container prefix), `common/images.ts`, `common/paths.ts`,
  `catalog/ports.ts`, `servers/runtime-spec.ts`, `servers/config-writer.service.ts`,
  `backups/backups.service.ts`.
- `docs/games/<slug>.md` — the per-game guide (see below).
- The UI cards that switch on game.

Say in the PR which upstream image you based the server container on and which of RCON,
telnet, an HTTP API, or nothing the game offers for a console — those differences are the
main thing reviewers check.

---

## Contributing Documentation

Palisade is free and open source. Documentation is Markdown in this repository. The per-game
guides in `docs/games/` are shipped content: `scripts/generate-game-docs.mjs` bundles them
into the web app on every build, so they appear verbatim in the in-app **Guide** tab.

### Working with Documentation Source Files

- Per-game guides live at `docs/games/<slug>.md`, where the slug maps to the `Game` enum value
  (`seven-days.md` → `SEVEN_DAYS`). Follow the structure of an existing guide: ports, joining,
  first boot, mods, and gotchas.
- Never edit `apps/web/lib/game-docs.generated.ts`. It is generated from the markdown and
  checked in so a clean checkout still builds; edit the markdown and rebuild.
- Product-level documentation (what Palisade is, install, features) lives in `README.md`.
- Images go beside the docs that use them, named after what they show, in lowercase with
  hyphens.

### Submitting Changes

Create a pull request to propose and collaborate on changes to a repository. Please follow the steps below:

1. Fork the project repository.
2. Clone the forked repository to your machine.
3. Create and switch into a new branch with your changes: `git switch -c doc_my_changes`
4. [Make your changes](#working-with-documentation-source-files).
5. Check what you wrote with a spellchecker to make sure you did not miss anything.
6. Test your changes before submitting a pull request: `pnpm --filter @ark/web build` regenerates the bundled guides, and `pnpm dev` shows them in the Guide tab.
7. Commit your changes: `git commit`
   - Pick the [type](#pull-request-title-guidelines) that matches what you changed. These steps use `docs:` because they describe a documentation change — for example **docs: rename "Research" to "Research Notes"** — but a code change on the same branch takes `feat:`, `fix:`, and so on.
   - Hard-wrap the commit message body at 75 characters. The pull request description is Markdown, so leave it unwrapped.
   - For more inspiration, see [How to Write a Git Commit Message](https://cbea.ms/git-commit/).
8. Push your branch: `git push origin doc_my_changes`
9. Submit your changes for review using the GitHub UI.
10. After publishing keep your ear to the ground for any feedback and comments in [Pull requests](https://github.com/Shakes63/palisade/pulls).

### Manual of Style

Follow [Our Philosophy](#our-philosophy) above, and match the voice of the guide you are
editing. Write for someone installing their first server: second person, present tense, plain
words, and a concrete command over a description of one.

---

## Communication

GitHub issues are the primary way for communicating about specific proposed changes to this project.
