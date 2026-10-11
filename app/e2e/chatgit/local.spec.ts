import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test('local entry, session restoration, protected routes and optional ChatGPT authorization', async ({
  page,
  context,
  baseURL,
}) => {
  const directory = process.env.CHATGIT_STATE_DIR;
  if (!directory || !baseURL) {
    throw new Error('Use an isolated CHATGIT_STATE_DIR and its E2E_BASE_URL for this test.');
  }
  expect(new URL(baseURL).hostname).toBe('127.0.0.1');
  expect(await (await fetch(`${baseURL}/api/local/status`)).json()).toEqual({ localMode: true });
  expect((await fetch(`${baseURL}/api/local/launch`, { method: 'POST' })).status).toBe(403);
  expect((await fetch(`${baseURL}/api/chatgpt/status`)).status).toBe(401);

  const artifacts = process.env.EVAL_ARTIFACT_DIR || '/tmp/chatgit-local-evidence';
  mkdirSync(artifacts, { recursive: true });
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'Open ChatGit on this device' })).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await page.screenshot({ path: path.join(artifacts, 'local-recovery.png') });

  // The launcher key and one-use ticket stay in memory and are never logged or traced.
  const ticket = execFileSync(
    'python3',
    [
      '-c',
      'import sys; sys.path.insert(0, "scripts"); from chatgit_open import read_origin, read_launch_key, request_ticket; print(request_ticket(read_origin(sys.argv[1]), read_launch_key(sys.argv[1])))',
      directory,
    ],
    { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8' },
  ).trim();
  await page.goto(`/api/local/open#ticket=${ticket}`);
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message input', exact: true })).toBeVisible();
  await expect(page.locator('.split-parent > [aria-hidden] > span').last()).toHaveCSS(
    'opacity',
    '1',
  );
  await page.screenshot({ path: path.join(artifacts, 'local-workspace.png') });

  const replay = await page.evaluate(async (usedTicket) => {
    const response = await fetch('/api/local/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: usedTicket }),
    });
    return response.status;
  }, ticket);
  expect(replay).toBe(401);

  const openConnections = async () => {
    await page.getByTestId('nav-user').click();
    await expect(page.getByRole('menuitem', { name: 'Log out' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Data & Privacy', exact: true }).click();
    await page.getByRole('button', { name: 'Model connections', exact: true }).click();
  };
  await openConnections();
  const connect = page.getByRole('button', { name: 'Continue with ChatGPT', exact: true });
  await expect(connect).toBeVisible();
  await expect(page.getByText('No key set', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, 'model-connections.png') });

  // Intercept only the provider's browser page. The app's login/callback/cancel APIs are real;
  // no external account is signed in and no real provider credentials are created.
  let authorize: URL | undefined;
  await context.route('https://auth.openai.com/**', async (route) => {
    authorize = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: '<p>Authorization test fixture</p>' });
  });
  let popupPromise = page.waitForEvent('popup');
  await connect.click();
  let popup = await popupPromise;
  await expect.poll(() => authorize?.pathname).toBe('/api/accounts/authorize');
  expect(authorize!.searchParams.get('redirect_uri')).toBe(`${baseURL}/api/chatgpt/callback`);
  expect(authorize!.searchParams.get('client_id')).toBe('dynamic_agent_client');
  expect(authorize!.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize!.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
  await page.bringToFront();
  await expect(page.getByText('Complete authorization in the OpenAI browser tab…')).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, 'chatgpt-pending.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(connect).toBeVisible();
  await popup.close();

  authorize = undefined;
  popupPromise = page.waitForEvent('popup');
  await connect.click();
  popup = await popupPromise;
  await expect.poll(() => authorize?.pathname).toBe('/api/accounts/authorize');
  const refused = await fetch(
    `${baseURL}/api/chatgpt/callback?error=access_denied&state=${encodeURIComponent(authorize!.searchParams.get('state')!)}`,
  );
  expect(refused.status).toBe(400);
  await popup.close();
  await page.bringToFront();
  await expect(page.getByRole('alert')).toHaveText(
    'Authorization was declined. Nothing was connected.',
  );
  await expect(connect).toBeEnabled();
  await page.screenshot({ path: path.join(artifacts, 'chatgpt-declined.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // Connected-state UI only: mock the provider status/catalog, not a real account grant.
  await context.route('**/api/chatgpt/status', (route) =>
    route.fulfill({ json: { enabled: true, state: 'connected', planUsage: true } }),
  );
  await context.route('**/api/chatgpt/models', (route) =>
    route.fulfill({ json: { models: [{ slug: 'fixture-model', displayName: 'UI test model' }] } }),
  );
  await page.evaluate(() => localStorage.setItem('color-theme', 'dark'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await openConnections();
  await expect(page.getByText('Connected to ChatGPT', { exact: true })).toBeVisible();
  await expect(page.getByText('Available models: UI test model', { exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, 'chatgpt-connected-ui-fixture.png') });
  await context.unroute('**/api/chatgpt/status');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(connect).toBeVisible();
});
