# Palisade — instructions for coding agents

Palisade is a self-hosted, Docker-based control panel for game dedicated servers. One lean
manager container (NestJS API + Next.js UI, SQLite via Prisma) talks to the host Docker
daemon and spawns, configures, and supervises a container per game server — settings, mods,
backups, schedules, RCON, players, clusters, and router port-forwards. Unraid-first, but it
runs on any Linux host with Docker.

This file is the shared instruction set for every agent working in this repo. Detailed
procedures live in `CONTRIBUTING.md` and the per-game guides (see [Where the depth
is](#where-the-depth-is)); keep this file short and limited to things that are true for all
work.

## Before you commit

These are enforced by CI (`.github/workflows/ci.yml`), so a change that skips them will fail
there instead of here:

```bash
pnpm db:generate     # typecheck reads the generated Prisma client
pnpm typecheck
pnpm lint            # ESLint covers apps/web; @ark/api and @ark/shared are stubs
pnpm test
pnpm build
```

`pnpm test` fakes Docker. The `*.docker.test.ts` suite runs against a real daemon and only
when you opt in — the same tier CI runs separately:

```bash
PALISADE_DOCKER_TESTS=1 pnpm --filter @ark/api test:docker
```

## Commits

Commit messages MUST follow the "Commit Message Guidelines" section of `CONTRIBUTING.md`.

In short: conventional commits, `<type>(<optional scope>): <description>`, with the type one
of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `revert`, and `build`, and
the scope lowercase and without spaces — `fix(rcon): reconnect after a container restart`.
The summary is imperative mood, no capital first letter, no trailing period, and describes
the change rather than the issue behind it, within 75 characters. Separate the body with a
blank line and wrap it at 75 characters. The body is normal prose explaining what
and why, never how, and says whether any interface changed.

Keep the message as short as the change allows — only what a reviewer absolutely needs, in
plain human-readable prose. Omit the body only when the change is genuinely self-explanatory.
Do not list files, restate the diff, or pad the message with narration.

Pull requests are squash-merged and the pull request title becomes the commit message on its
own, so the title must read as a complete commit summary under the same rules — a branch's
own commit messages do not survive. Most of the history predates this convention and uses
plain capitalised sentences; that is the old style, not a second accepted one.

Each commit is one atomic logical change: the tree must build at that commit, reverting it
must not break the commits around it, and it should do one thing. Fold review fixes and typo
corrections into the commit they fix rather than leaving them as separate commits, but do not
flatten a branch that genuinely does several separable things into one commit. See
"Structuring Commits" in `CONTRIBUTING.md`.

Do not commit or push unless you were asked to.

## Code changes

Binding as written on every change; `.claude/skills/karpathy-guidelines/SKILL.md` holds the
full text.

**Think before coding.** State assumptions explicitly and ask when uncertain. If several
interpretations exist, present them instead of silently picking one. If a simpler approach
exists, say so.

**Simplicity first.** Minimum code that solves the problem. No speculative features, no
abstractions for single-use code, no unrequested configurability, no error handling for
impossible states. If 200 lines could be 50, rewrite it.

**Surgical changes.** Every changed line traces to the request. Don't improve adjacent code,
comments, or formatting. Match existing style. Remove only the orphans your own change
created; mention pre-existing dead code rather than deleting it.

**Goal-driven execution.** Turn the task into a verifiable goal ("fix the bug" → "write a
test that reproduces it, then make it pass") and name the verification step for each step of
a multi-step plan.

## Code comments

Default to none. A comment must earn its line.

- Comment only the _why_: a non-obvious constraint, a workaround and its cause, an invariant
  the reader cannot infer, a spec or issue reference. Never the _what_.
- One line, two at most. An explanation needing a paragraph belongs in a commit message or a
  docs file — or the code needs restructuring.
- No prose blocks above functions, no section banners, no decorative separators.
- No narration of the edit ("changed X to Y", "new helper", "as requested"). That is the
  diff's job.
- Docstrings only where the language or the file already uses them, and then one line unless
  the neighbours are longer.
- Match the file's existing comment density. A file with no comments gets no new ones.

When a change exists only because a fix is pending upstream (an open PR, an unreleased
version of a game-server image, a dependency waiting on a release), mark it with a `TODO`
naming what is awaited, so the workaround can be deleted once it lands. Link the upstream
pull request or issue by full URL, so the next reader can check its state without hunting
for it:

```ts
// TODO: drop once https://github.com/itzg/docker-minecraft-server/pull/123 lands and the image is bumped.
```

## Layout

pnpm workspace, TypeScript throughout. `apps/*` and `packages/*`.

- `apps/api/` — NestJS backend. One directory per feature module under `src/`: `servers/`,
  `docker/`, `catalog/`, `mods/`, `backups/`, `scheduler/`, `rcon/`, `players/`, `clusters/`,
  `portforwards/`, `adoption/`, `installer/`, `auth/`, `realtime/`, `common/`, …
  Prisma schema and migrations in `apps/api/prisma/`.
- `apps/web/` — Next.js 15 App Router UI (`app/`, `components/`, `lib/`), Tailwind.
- `packages/shared/` — the contract between them: the `Game` enum, DTOs, socket event names,
  settings catalog types, version pinning. Anything both sides must agree on lives here,
  never duplicated on one side.
- `apps/api/src/catalog/<game>.catalog.ts` — one settings catalog per game. **The game's
  quirks live here**, not scattered through the services: which settings exist, how they are
  serialised (env, INI, JSON, XML, `.sii`, `.cfg`), and their help text.
- `docker/` — entrypoint and per-game image assets baked into the manager image.
- `docs/games/<slug>.md` — one guide per game; `scripts/generate-game-docs.mjs` bundles them
  into `apps/web/lib/game-docs.generated.ts` on every web build. Edit the markdown, never the
  generated file.
- `unraid/palisade.xml` — the Community Applications template (env vars, mounts, ports).
  Community Applications does not install from this file: `sync-ca-template.yml` copies it to
  a separate template repo on each `v*` tag, so an edit here reaches users at the next
  release, not at merge. Run that workflow by hand to correct drift.
- `scripts/`, `.github/workflows/` — tooling and CI: `ci.yml`, `docker-publish.yml` (stable,
  tag-driven), `nightly.yml`, `sync-ca-template.yml`.

New backend code goes in an existing feature module, or a new `apps/api/src/<feature>/` with
`<feature>.module.ts`, `<feature>.service.ts`, `<feature>.controller.ts`:

```ts
@Injectable()
export class <Feature>Service {}
```

File names are kebab-case, classes PascalCase, and anything the UI also needs is exported
from `@ark/shared` rather than redeclared in `apps/web`.

## Everyday commands

| Task                        | Command                                                     |
| --------------------------- | ----------------------------------------------------------- |
| Run API + UI in watch mode  | `pnpm dev`                                                  |
| Typecheck everything        | `pnpm typecheck`                                            |
| Fast test suite             | `pnpm test` (or `pnpm --filter @ark/api test -- <file>`)    |
| Docker integration tests    | `PALISADE_DOCKER_TESTS=1 pnpm --filter @ark/api test:docker` |
| Regenerate the Prisma client | `pnpm db:generate`                                         |
| Create the dev database     | `pnpm --filter @ark/api db:push`                            |
| Create a migration          | `pnpm db:migrate`                                           |
| Apply migrations            | `pnpm --filter @ark/api db:deploy`                          |
| Build the image locally     | `docker build -t palisade:dev .`                            |
| Run the whole stack         | `docker compose up --build`                                 |
| Deploy to a test Unraid box | `scripts/deploy-unraid.sh <ssh-host> [tag] [container-name]` |

`deploy-unraid.sh` defaults to `tower latest Palisade` and recreates that container with the
env, mounts, and data it already has; the third argument targets a second instance
(`… tower nightly Palisade-test`). `… <host> nightly` rides the prerelease channel, which can
apply migrations a later rollback to a stable tag cannot undo — Prisma only migrates forward,
so take a backup first.

`.env.example` documents every variable the manager reads, and the Unraid template sets the
same ones in production. It is copied to two different places for two different purposes:
`apps/api/.env` is what `pnpm dev` and the Prisma CLI read, while a root `.env` is read only
by Compose, which needs `SECRETS_KEY` and `JWT_SECRET` filled in. Never commit a real `.env`,
key, or API token.

## Things that bite

- **A game is not one file.** Adding or changing a game touches a fixed set of places:
  `packages/shared/src/game.ts` (enum + label + pinning), a
  `apps/api/src/catalog/<game>.catalog.ts`, `catalog.service.ts`, `common/naming.ts`
  (container prefix), `common/images.ts`, `common/paths.ts`, `catalog/ports.ts`,
  `servers/runtime-spec.ts`, `servers/config-writer.service.ts`, `backups/backups.service.ts`,
  plus `docs/games/<slug>.md` and the UI cards. Grep an existing game's enum value
  (`grep -rl CORE_KEEPER apps packages`) before you start — that list is the checklist.
- **Games are not uniform, and assuming they are is the most common bug here.** Some are
  native Linux, some Proton, some Wine; some have real Source RCON, some telnet, some an
  HTTPS API, some no console at all; some are env-driven, others need a config file rendered
  and patched. Read the `Game` enum docblocks and the game's catalog before generalising.
- **Most game images are third-party community images.** Their env var names, paths, and
  readiness signals are their contract, not ours. When behaviour looks wrong, check the
  upstream image before changing our side, and pin versions rather than tracking `latest`.
- **The fast test suite fakes Docker, and the fake has been wrong.** Container-id length,
  JSON key ordering, and network membership all bit in one week. Anything depending on real
  daemon behaviour needs a `*.docker.test.ts`, not just a unit test.
- **Docker returns container ids at two lengths.** `network inspect` gives the full 64 chars;
  a container's own hostname is the 12-char short form. Compare with the helper in
  `common/shared-network.ts`, never with `===`.
- **The shared network is `palisade-net`, and the name is load-bearing on Unraid.** Unraid
  derives the WebUI button's address from the first entry of the container's network map,
  sorted by name, so a name sorting ahead of `br0`/`bond0`/`eth0` pointed the button at the
  bridge IP instead of the LAN one (GH #31). `ark-net` is the pre-1.11 legacy network, still
  honoured for installs that have servers on it — `common/shared-network.ts` owns that
  migration, and its rules are deliberately one-way.
- **Containers are matched by the `ark.serverId` label, not by name.** Container name
  prefixes are cosmetic; never identify a managed container by parsing its name.
- **Adoption must not assume an install's history.** Importing existing containers runs on
  boxes that were never on an older layout, and on containers Palisade did not create; guard
  every "the old thing must be there" assumption (GH #71, #89, #91).
- **`docs/games/*.md` is shipped content**, bundled into the in-app Guide tab. A doc edit is
  a product change, and the generated bundle is checked in so a stale checkout still builds.
- **Publishing is tag-driven.** A push to `main` publishes no image; a `vX.Y.Z` tag builds and
  pushes `latest` plus the semver and short-sha tags, gated on `pnpm audit --prod
  --audit-level high` and a Trivy CRITICAL scan. `nightly.yml` is manual-only and never moves
  `latest`.
- **Secrets are generated on first start and encrypted at rest.** Don't add a setup step that
  asks a user to generate a key in a terminal, and never log a decrypted secret or write one
  into a game container's config in plain sight of the logs.
- **The app data directory must be a real disk path on Unraid**, not the `/mnt/user` FUSE
  share, or the game-file cache cannot reflink-clone between servers.

## Where the depth is

- `.claude/skills/karpathy-guidelines/SKILL.md` — the full text behind [Code
  changes](#code-changes), vendored from
  <https://github.com/multica-ai/andrej-karpathy-skills> (MIT). It binds every change whether
  or not anything loads it.
- `CONTRIBUTING.md` — fork and PR workflow, the full commit message and PR title rules, how
  to add a game, and the documentation style.
- `README.md` — what the product is, the supported-game table, install and feature overview.
- `PLANNING.md` — the original build plan and the decisions the architecture rests on.
- `docs/games/README.md` — the per-game guides: ports, joining, first boot, mods, gotchas.
