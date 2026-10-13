# ChatGit

ChatGit is being built on [LibreChat](https://github.com/LibreChat-AI/LibreChat).

| Path | Contents |
| --- | --- |
| `app/` | LibreChat v0.8.8 at [the pinned upstream revision](https://github.com/LibreChat-AI/LibreChat/commit/e1dfc10449ff713faffacd60273fddcfe2c0a698), customized for ChatGit |
| `app/web/` | The ChatGit canvas UI (React 19 + Arc UI), its own package and lock; served at `/canvas/` |
| `docs/canvas-design.md` | Interaction and architecture decisions for the canvas |
| `legacy/chatgit/` | The previous Next.js ChatGit, kept for reference only |
| `scripts/` | Protected task supervisor (`next_safe.py`), toolchain installer, runtime launcher, and their tests |
| `.agents/setup`, `.amp/services.yaml` | Amp orb setup and the supervised `chatgit` service |

Read [AGENTS.md](AGENTS.md) before running anything. Every heavy task goes through the root npm scripts.

## Requirements

- Python 3.9+ and `ps` (macOS or Linux)
- Node **24.16.0** (`.nvmrc`, which matches upstream `app/.nvmrc`). `.agents/setup` installs it from nodejs.org after checking a pinned SHA-256. nvm's `~/.nvm/versions/node/v24.16.0` also works. No other version is accepted.
- `mongod`. On Debian 12 x86_64, setup downloads MongoDB 8.2.1 to `~/.cache/mongodb-binaries/` after checking a pinned SHA-256. On other platforms, set `CHATGIT_MONGOD` or put `mongod` on `PATH`. An external `MONGO_URI` requires account-protected mode (`CHATGIT_LOCAL_MODE=false`).

## Commands

```bash
.agents/setup              # idempotent: Node + mongod + `npm ci` in app/ and app/web/ (each skipped if its lock is unchanged)
npm run check:safety       # JSON environment report; exit 2 if Node/deps/disk are not ready
npm run build              # sequential: data-provider → data-schemas → api → client-package → client build:file → web
npm run dev -- --port 3080 # persistent mongod + Express serving the canvas UI (app/web/dist) and the API
npm run open              # in another terminal on the same device: opens your private workspace
npm run test:safety        # supervisor, cleanup, runtime and toolchain unit tests
npm run setup:app          # dependency step alone (`-- --force` to reinstall)
```

`npm run dev` never builds. It refuses to start if a build output is missing or the port is already taken. The client build writes its log to `app/client/vite-output.log`, and the last lines are printed if it fails. Stop a running task with Ctrl-C, or with `amp orb service stop chatgit` for the orb service. The supervisor then cleans up the task's whole process group.

### Personal app: no signup or password

Local mode is the default. Run `npm run open` on the same device as the running app, with a graphical browser available. It reads a private local launch key and opens a 60-second, single-use entry; the browser then keeps the normal protected session. Opening `/login` or `/register` without that session shows launcher instructions, not an account form. This is a browser-based development app, not yet a packaged desktop installer.

LibreChat's internal ownership and session checks remain in place. On an empty database ChatGit creates one passwordless local owner; it never registers an account at LibreChat or adopts an existing user's data. If a database already contains accounts but has no local-owner binding, opening is refused. Keep using those accounts with `CHATGIT_LOCAL_MODE=false`, or select a new `CHATGIT_STATE_DIR`; do not delete the old database or rotate its keys.

Conversations are stored on the device running ChatGit. In an Amp orb, that means the orb, not your computer. Calling a remote model sends the chosen conversation context to that provider.

### Optional ChatGPT plan connection

In the canvas UI's **Model connections & settings** (gear icon), choose **Connect with ChatGPT**, or configure the separate **OpenAI-Compatible** URL/key connection. The ChatGPT option uses OpenAI's documented [open-source Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), using the same account you use for Codex; it does not reuse Codex's client identity or read its credential files. You grant access yourself in OpenAI's browser page. Eligibility and available models depend on your account and OpenAI's current offering.

This implementation holds one ChatGPT connection per local workspace. Tokens and the host identity are written atomically with owner-only permissions under `<state>/chatgpt/`; refresh is serialized and disconnect removes local tokens, attempts remote revocation, and reports unconfirmed revocation. Models come from the authorized account. Inference uses the official Responses endpoint with `store:false`, streams replies, and replays ChatGit's own ordered context. It never silently falls back to API-key billing. It does not import ChatGPT conversations or run Codex tools. The real consent/token/inference round trip still needs testing with a user's eligible account; automated tests use a simulated provider.

### Safety limits (do not raise)

Install, build and dev share one lock, so only one runs at a time. Each step runs in its own process group with these limits:

- at most 32 processes
- at most 6 GiB RSS for the group
- at least 10 GiB of free disk
- `--max-old-space-size=2048` for every Node process, appended last to `NODE_OPTIONS`

The supervisor rejects any build script that sets its own heap size.

## Runtime environment contract

`scripts/chatgit_runtime.py` (started by `npm run dev`) layers the environment in this order, later sources winning:

1. built-in defaults
2. `.chatgit/secrets.env`
3. `.chatgit/local.env`
4. the process environment
5. `--port`
6. local-mode enforcement (fixed loopback address/database, disabled registration and password login)

| Variable | Default | Notes |
| --- | --- | --- |
| `CHATGIT_LOCAL_MODE` | `true` | Personal account-free app; `false` keeps account-protected preview behavior |
| `PORT` | `--port`, else `$PORT`, else 3080 | |
| `HOST` | `127.0.0.1` | |
| `DOMAIN_CLIENT` / `DOMAIN_SERVER` | `http://127.0.0.1:<port>` in local mode | Fixed origin; account mode defaults to `http://localhost:<port>` |
| `NODE_ENV` | `production` | |
| `APP_TITLE` | `ChatGit` | The LibreChat yaml schema has no appTitle field |
| `CONFIG_PATH` | `app/chatgit.yaml` | Relative paths resolve from the repo root; the file must exist |
| `MONGO_URI` | managed: `mongodb://127.0.0.1:<CHATGIT_MONGO_PORT>/ChatGit` | External URI accepted only in account mode; then no managed mongod starts |
| `CHATGIT_MONGO_PORT` | `27017` | Port for the managed mongod |
| `CHATGIT_MONGOD` / `CHATGIT_NODE` | discovered | Explicit binary paths |
| `CHATGIT_STATE_DIR` | `.chatgit/` | Set in the process environment, before reading local env files |
| `CREDS_KEY`, `CREDS_IV`, `JWT_SECRET`, `JWT_REFRESH_SECRET` | generated once into `.chatgit/secrets.env` (mode 600) | Never rotated or printed |
| `ENDPOINTS` | `agents` | Ambient provider keys do not add built-in endpoints |
| `ALLOW_EMAIL_LOGIN`, `ALLOW_REGISTRATION` | forced `false` in local mode | Default `true` only in account-protected mode; disable registration after preview accounts exist |
| `ALLOW_SOCIAL_LOGIN`, `ALLOW_SOCIAL_REGISTRATION`, `ALLOW_PASSWORD_RESET` | `false` | |
| `SEARCH`, `USE_REDIS` | `false` | |
| `NO_INDEX` | `true` | |
| `TRUST_PROXY` | `1` | |

The managed mongod listens on 127.0.0.1 only, with a 0.25 GiB WiredTiger cache. Its data lives in `.chatgit/mongodb/` and its log in `.chatgit/logs/mongod.log`. It runs inside the supervised group and keeps its data across restarts. Uploads stay in LibreChat's own `app/uploads/` (ignored). If `app/.env` exists, LibreChat's dotenv fills in any unset variables from it, and the runtime prints a warning.

## App configuration

`app/chatgit.yaml` does the following:

- keeps conversations, model selection and presets
- turns off agents and the marketplace, prompts, memories, bookmarks, multi-conversation, web search, code execution, file search, skills, remote agents and MCP UI
- limits ephemeral-agent capabilities to `context` ("Upload as Text")
- defines **OpenAI-Compatible**, with user-provided `apiKey` and `baseURL`, and **ChatGPT**, with optional local ChatGPT-plan authorization. The latter has no hard-coded model list and is unavailable in remote preview mode.

It configures no mock model. The separate [browser regression setup](app/e2e/chatgit/README.md) uses a local HTTP fixture without changing this default.

## ChatGit canvas

`/` opens the canvas UI (`/canvas/`); the launcher and the Web Portal land there. Decisions are recorded in [docs/canvas-design.md](docs/canvas-design.md).

- **Own graph model.** Canvases (`chatgit_canvases`) hold drafts and the reading position; nodes (`chatgit_nodes`) are one question and answer each, with `parentIds` as context sources. It does not use LibreChat's message tree.
- **Context is assembled on the server** (`app/api/server/services/ChatGit/canvasContext.js`): the union of the sources' ancestor paths in creation order, each shared turn once; unselected sibling branches never appear. Quoted passages travel with the question. When a path is long, turns older than the newest three are replaced by their stored summary; direct sources and turns without a summary stay verbatim, so nothing is silently dropped. Limits: 12 sources, 20 quoted passages, 8,000 characters per question, 1,500 per quote.
- **Generation** (`app/api/server/routes/chatgitCanvas.js`, `/api/chatgit/*`) streams over SSE and continues if the page closes; partial text is saved as it arrives and a reload picks the result up. Stop keeps the partial answer. After an answer, one small extra model call stores a short summary (used for compression) and three suggested follow-ups, shown only as buttons.
- **Models** come from LibreChat's configured endpoints (OpenAI-compatible, ChatGPT) via the same provider options as LibreChat's own calls; the model is chosen per canvas.
- The UI ships in Simplified Chinese, Traditional Chinese and English (`app/web/src/locales.ts`; `npm run build` fails if a string is untranslated).

Not yet in the canvas UI: attachments, voice input and importing old conversations. The LibreChat chat UI and its message canvas below remain reachable at `/c/new` during the migration.

## Legacy LibreChat message canvas

Chat and Message canvas read the same stored messages. A normal parent link remains LibreChat's primary conversation path; `canvasSources` adds explicit cross-branch references without turning alternative branches into one linear chat.

- **Ask from this node** retains that message and its ancestors, but excludes existing replies. **Rewrite as sibling** keeps only the history before the question; it leaves the original question and its replies intact.
- The browser sends source IDs, not a client-authored context. The server resolves them from the authenticated user's already-loaded conversation rows, captures complete text versions and ancestors, deduplicates shared history, and labels the separate branches before sending them to the provider.
- Each referencing question stores a frozen `canvasContext`. Follow-ups replay those references; later source edits do not silently change the original selection. The source snapshot can be inspected in the reading panel.
- The final model-call guard rejects missing/pruned references and summarization of referenced material. It never silently substitutes a summary for the selected text. The resume guard checks structural integrity; exact resume provenance remains a limitation, and tool/HITL features are disabled in this product configuration.
- Reading defaults to a side panel; dialog mode is a browser-local saved preference. Canvas drafts and selections are per-conversation session state.

This first implementation references **completed text branches only**: file/image/tool ancestors and unfinished answers cannot be selected. Ordinary chat still supports text-file uploads. Reference limits are currently 12 sources, 200 captured messages, 200,000 stored text characters and 48,000 rendered reference characters; an oversized selection is rejected, not truncated.

The old Next.js browser records are not automatically imported into MongoDB. The source remains in `legacy/chatgit/`; no old browser data is deleted. Disabled upstream features remain in the imported source for now, with their product entry points turned off rather than a destructive source-code purge.

## Orbs

`.agents/setup` installs only the toolchain and dependencies: it does not build, start services, or create `.chatgit/`. After building, `amp orb services ensure` starts the account-free app with isolated preview data under `.chatgit/local-preview/` and prints the **ChatGit Web Portal** link. Open that link directly: there is no remote desktop to operate and no ChatGit signup or password. The service uses the same stored local workspace, not a second account or database. This is a preview hosted in the orb, not an installation on your computer.

`CHATGIT_PORTAL_MODE=true` is an explicit orb-only entry boundary, separate from the private local launcher. It requires Amp's orb/thread/owner metadata and the HTTPS `PUBLIC_URL` supplied by the service manager. Every portal request must reach the loopback server with that exact Host, HTTPS forwarding metadata, and Amp's authenticated collaborator identity matching the orb owner. Missing or different identities are refused even if they carry a ChatGit session. The normal local launcher endpoints remain loopback-only. Portal session cookies are Secure, HttpOnly and partitioned so the app works inside Amp's Portal pane; local browser cookies are unchanged. Do not make this personal-workspace portal public.

The Desktop launcher `.amp/open-chatgit.sh` remains an optional fallback, not the normal preview. The default configuration still uses real model providers; opening the preview does not configure a model or authorize billable inference. A ChatGPT sign-in flow with a device-local callback still needs to run on the device hosting ChatGit; it is not verified for a remote Web Portal.

Do not switch to `CHATGIT_LOCAL_MODE=false` merely to provide a preview link: that exposes the upstream account workflow, which is not ChatGit's personal-app experience. Existing account-mode data is left untouched. Start only the intended service; `amp orb services ensure` may start other declared orb services too.
