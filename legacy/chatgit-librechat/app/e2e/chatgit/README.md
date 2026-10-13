# ChatGit browser regression (orb / Linux)

This is a development correctness check, not a model-quality benchmark. It registers a test user in an isolated account-mode fixture (not the local product), exercises the actual UI and MongoDB, and inspects the HTTP messages received by the bundled OpenAI-compatible fixture. It covers independent branches, common-history deduplication, sibling exclusion, frozen context after reload, ordinary follow-up, both question-branch operations, stopping, text upload, reading preferences and desktop keyboard access. ChatGit targets desktop windows, with Chinese/English and System/Light/Dark appearance; narrow-screen and app high-contrast modes are not acceptance targets.

Start with the root `.agents/setup`, `npm run check:safety` and `npm run build`. Stop a running ChatGit service before building or running the isolated test app. Never run the upstream frontend/backend scripts directly.

From the ChatGit root, use the pinned toolchain and disposable test state:

```bash
export PATH="$HOME/.local/share/chatgit/node/node-v24.16.0-linux-x64/bin:$PATH"
export NODE_OPTIONS=--max-old-space-size=2048

# Only if port 8889 has no existing test fixture. This server calls no external model.
amp orb service start chatgit-test-model --command 'E2E_LABEL_PORT=8889 node app/e2e/setup/fake-label-server.js'

amp orb service start chatgit-check --command 'CHATGIT_LOCAL_MODE=false CHATGIT_STATE_DIR="$PWD/.chatgit/browser-check" CONFIG_PATH=app/e2e/chatgit/config.yaml npm run dev -- --port "$PORT"' --portal

# Use the loopback port printed for chatgit-check, not a shared/production server.
E2E_BASE_URL=http://localhost:<port> node app/node_modules/@playwright/test/cli.js test --config=app/e2e/chatgit/playwright.config.ts

amp orb service stop chatgit-check
# Stop chatgit-test-model only if you started it for this check.
# Reload the account-free local preview, opened through Amp's Desktop portal.
amp orb service restart chatgit
```

The test fixture is a separate service and the test app still runs through the root resource guard. Never run two app services together. Do not stop another thread's fixture service, or use a bulk service command to restart unrelated experiments.

Browser outputs go to `/tmp/chatgit-browser-tests` and `/tmp/chatgit-browser-evidence`. `EVAL_ARTIFACT_DIR` can select a review-output directory. `/tmp/chatgit-browser-state.json` holds private test login state: never commit or share it. Screenshots contain fixture answers, not actual LLM output.

## Canvas UI check (`/canvas/`)

Uses the real launcher, a separate empty state directory and a local OpenAI-compatible fixture that calls no
external model. `canvas.yaml` is the product config plus the fixture endpoint; it is never the default.

```bash
amp orb service start chatgit-canvas-fixture --command "$HOME/.local/share/chatgit/node/node-v24.16.0-linux-x64/bin/node app/e2e/chatgit/fake-openai.js"
amp orb service start chatgit-canvas-check --command 'CHATGIT_LOCAL_MODE=true CHATGIT_STATE_DIR="$PWD/.chatgit/canvas-check" CONFIG_PATH=app/e2e/chatgit/canvas.yaml npm run dev -- --port "$PORT"'
```

Enter through the launcher (`npm run open` with `CHATGIT_STATE_DIR` set to the same directory). The fixture records
what the model received at `GET http://127.0.0.1:8890/__requests`; `POST /__behavior {"fail":true}` or
`{"delayMs":300}` exercises errors and stopping. Stop `chatgit-canvas-check` before rebuilding: the build waits for
the shared lock.

Unit tests for context assembly (from `app/api`):
`node ../node_modules/jest/bin/jest.js --runInBand --coverage=false server/services/ChatGit/canvasContext.spec.js`.

## Account-free local app and ChatGPT connection

Stop the preview first. This check uses a separate empty database, the real Python launcher request, real browser session/refresh, and the default real-provider config. No external model is called. The authorization browser page is intercepted; cancellation and declined callbacks go to the real backend. Connected/model-list rendering uses explicitly simulated status responses. It does **not** prove that an actual OpenAI account can authorize or perform inference.

```bash
amp orb service start chatgit-local --command 'CHATGIT_STATE_DIR="$PWD/.chatgit/device-check" npm run dev -- --port "$PORT"'
# Substitute the printed local service port below; keep the state directory identical.
E2E_BASE_URL=http://127.0.0.1:<port> CHATGIT_STATE_DIR="$PWD/.chatgit/device-check" node app/node_modules/@playwright/test/cli.js test --config=app/e2e/chatgit/local.config.ts
amp orb service stop chatgit-local
```

`local.config.ts` disables tracing and automatic failure screenshots so one-use launch URLs are not captured. Review screenshots go to `/tmp/chatgit-local-evidence`, or `EVAL_ARTIFACT_DIR`. Preserve the test state for reruns; do not use a database containing real users. The browser check also verifies absent API keys are not presented as saved non-expiring keys.

Focused non-browser checks (from the named workspace, with the same PATH/heap limit):

- `app/packages/api`: `node ../../node_modules/jest/bin/jest.js --runInBand src/messages/canvas.spec.ts src/stream/__tests__/abortCanvasFields.spec.ts`
- `app/packages/api`: `node ../../node_modules/jest/bin/jest.js --runInBand --coverage=false --runTestsByPath src/auth/local/router.spec.ts src/endpoints/chatgpt/__tests__/connection.spec.ts src/endpoints/chatgpt/__tests__/router.spec.ts src/endpoints/chatgpt/__tests__/request.spec.ts src/endpoints/custom/chatgpt.spec.ts`
- `app/api`: `node ../node_modules/jest/bin/jest.js --runInBand server/controllers/agents/client.test.js server/middleware/abortMiddleware.spec.js server/routes/__tests__/messages-get.spec.js server/controllers/agents/__tests__/request.resumeMetadata.spec.js`
- `app/client`: `node ../node_modules/jest/bin/jest.js --runInBand src/utils/__tests__/documentTitle.test.ts`
- Root: `npm run test:safety`.
