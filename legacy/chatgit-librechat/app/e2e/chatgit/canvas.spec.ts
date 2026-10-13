import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { TMessage } from 'librechat-data-provider';

test('ChatGit: branches, deduplicated provider payload, saved context and reading modes', async ({
  page,
}) => {
  const email = `canvas-${Date.now()}@example.com`;
  const password = randomBytes(24).toString('base64');
  const register = await page.request.post('/api/auth/register', {
    data: { email, password, confirm_password: password, name: 'ChatGit Evaluation' },
  });
  expect(register.ok()).toBeTruthy();
  const login = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const fixture = async (label: string, hold = false) => {
    const response = await page.request.post('http://127.0.0.1:8889/__e2e/behavior', {
      data: { label, hold },
    });
    expect(response.ok()).toBeTruthy();
  };
  const outbound = async () =>
    (await (await page.request.get('http://127.0.0.1:8889/__e2e/requests')).json()).requests;
  const lastPrompt = async () => (await outbound()).at(-1).prompt as string;
  const messages = async (): Promise<TMessage[]> => {
    const id = new URL(page.url()).pathname.split('/').at(-1);
    const response = await page.request.get(`/api/messages?conversationId=${id}&pageSize=100`, {
      headers,
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).messages;
  };
  const waitSaved = async (reply: string) => {
    await expect
      .poll(
        async () =>
          (await messages()).some(
            (message) =>
              !message.unfinished &&
              !message.error &&
              (message.text?.includes(reply) ||
                JSON.stringify(message.content ?? []).includes(reply)),
          ),
        { timeout: 20000 },
      )
      .toBe(true);
  };
  const chatSend = async (question: string, reply: string) => {
    await fixture(reply);
    await page.getByRole('textbox', { name: 'Message input', exact: true }).fill(question);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page).toHaveURL(/\/c\/(?!new)[a-z0-9-]+$/);
    await waitSaved(reply);
  };
  const canvasSend = async (question: string, reply: string) => {
    await fixture(reply);
    await page.getByRole('textbox', { name: 'New question', exact: true }).fill(question);
    await page.getByRole('button', { name: 'Ask on new branch', exact: true }).click();
    await waitSaved(reply);
  };
  const openCanvas = async () => {
    await page.getByRole('button', { name: 'Message canvas', exact: true }).click();
    await expect(page.getByTestId('canvas-graph')).toBeVisible();
  };
  const inspectNode = async (marker: string) => {
    await page.getByRole('button', { name: 'Fit all messages in view', exact: true }).click();
    await page.locator('.react-flow__node').filter({ hasText: marker }).getByRole('button').click();
  };

  await test.step('ordinary chat shares the same persisted messages with the canvas', async () => {
    await page.goto('/c/new');
    await chatSend(
      'BASE_CONTEXT: 周末出行，对比不同路线，保留各自预算。',
      'BASE_REPLY: 共同背景已确认。',
    );
    await page.reload();
    await expect(page.getByText('BASE_REPLY: 共同背景已确认。', { exact: true })).toBeVisible();
    await openCanvas();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
  });

  await test.step('create two independent branches plus an unselected control branch', async () => {
    for (const [question, reply] of [
      ['PLAN_A: 城市博物馆，预算 2000 元。', 'ANSWER_A: 室内路线，预算保持 2000 元。'],
      ['PLAN_B: 户外徒步，预算 5000 元。', 'ANSWER_B: 户外路线，预算保持 5000 元。'],
      ['UNSELECTED_BRANCH: 不应带入的第三条路线。', 'UNSELECTED_REPLY: 这段内容不属于本次比较。'],
    ]) {
      await inspectNode('BASE_REPLY:');
      await page.getByRole('button', { name: 'Ask from this node', exact: true }).click();
      await canvasSend(question, reply);
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(8);
    const saved = await messages();
    const root = saved.find((message) => message.text.startsWith('BASE_CONTEXT:'))!;
    const baseline = saved.find(
      (message) => message.parentMessageId === root.messageId && !message.isCreatedByUser,
    )!;
    for (const prefix of ['PLAN_A:', 'PLAN_B:', 'UNSELECTED_BRANCH:']) {
      expect(saved.find((message) => message.text.startsWith(prefix))?.parentMessageId).toBe(
        baseline.messageId,
      );
    }
  });

  let mergedMessage: TMessage;
  let mergedProviderRequest: unknown;
  await test.step('selected branch histories are deduplicated in the actual HTTP provider request', async () => {
    await page.getByRole('button', { name: 'Fit all messages in view', exact: true }).click();
    await page.getByRole('checkbox', { name: /Use as context ANSWER_A:/ }).check();
    await page.getByRole('checkbox', { name: /Use as context ANSWER_B:/ }).check();
    await canvasSend(
      'MERGE_QUESTION: 对比这两条路线，不要把预算合并。',
      'MERGE_REPLY: 已收到分组整理后的两条路线。',
    );
    const prompt = await lastPrompt();
    for (const marker of [
      'BASE_CONTEXT:',
      'BASE_REPLY:',
      'PLAN_A:',
      'ANSWER_A:',
      'PLAN_B:',
      'ANSWER_B:',
      'MERGE_QUESTION:',
    ]) {
      expect(prompt.split(marker).length - 1, marker).toBe(1);
    }
    expect(prompt).toContain('2000');
    expect(prompt).toContain('5000');
    expect(prompt).not.toContain('UNSELECTED_BRANCH');
    expect(prompt).not.toContain('UNSELECTED_REPLY');
    mergedProviderRequest = (await outbound()).at(-1);
    mergedMessage = (await messages()).find((message) =>
      message.text.startsWith('MERGE_QUESTION:'),
    )!;
    expect(mergedMessage.canvasSources).toHaveLength(2);
    expect(mergedMessage.canvasContext?.nodes).toHaveLength(6);
    expect(mergedMessage.text).toBe('MERGE_QUESTION: 对比这两条路线，不要把预算合并。');
  });

  await test.step('source links and snapshots survive reload; normal follow-up inherits them once', async () => {
    await page.reload();
    const restored = (await messages()).find(
      (message) => message.messageId === mergedMessage.messageId,
    )!;
    expect(restored.canvasContext).toEqual(mergedMessage.canvasContext);
    await openCanvas();
    await expect(page.locator('.react-flow__node')).toHaveCount(10);
    await expect(page.locator('.react-flow__edge').filter({ hasText: 'Reference' })).toHaveCount(2);
    await inspectNode('MERGE_QUESTION:');
    await expect(page.getByTestId('canvas-snapshot')).toBeVisible();
    await page.getByTestId('canvas-snapshot').locator('summary').click();
    const artifactDir = process.env.EVAL_ARTIFACT_DIR || '/tmp/chatgit-browser-evidence';
    mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: `${artifactDir}/librechat-canvas.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.screenshot({ path: `${artifactDir}/chatgit-dark.png`, animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.getByRole('combobox', { name: 'Reading mode' }).selectOption('dialog');
    await inspectNode('MERGE_QUESTION:');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: `${artifactDir}/chatgit-dialog.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('combobox', { name: 'Reading mode' }).selectOption('side');
    await page.getByRole('button', { name: 'Fit all messages in view', exact: true }).click();
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await chatSend(
      'FOLLOWUP: 保留这两条路线继续分析。',
      'FOLLOWUP_REPLY: 两条路线的来源仍然保留。',
    );
    const prompt = await lastPrompt();
    for (const marker of ['BASE_CONTEXT:', 'PLAN_A:', 'ANSWER_A:', 'PLAN_B:', 'ANSWER_B:']) {
      expect(prompt.split(marker).length - 1, marker).toBe(1);
    }
    await page.screenshot({ path: `${artifactDir}/librechat-chat.png` });
    writeFileSync(
      `${artifactDir}/librechat-request-evidence.json`,
      JSON.stringify(
        {
          baselineCommit: 'e1dfc10449ff713faffacd60273fddcfe2c0a698',
          model: 'local HTTP fixture, not a real LLM',
          conversationPath: new URL(page.url()).pathname,
          mergedProviderRequest,
          persistedSourceSnapshot: restored.canvasContext,
          followupProviderRequest: (await outbound()).at(-1),
        },
        null,
        2,
      ),
    );
  });

  await test.step('question rewrite excludes the old question and answer; ask-from-question retains only the question', async () => {
    await openCanvas();
    await inspectNode('PLAN_A:');
    await page.getByRole('button', { name: 'Rewrite as sibling', exact: true }).click();
    await canvasSend('REWRITTEN_A: 将城市路线改为公园。', 'REWRITE_REPLY: 新问题已单独回答。');
    let prompt = await lastPrompt();
    expect(prompt).toContain('BASE_CONTEXT:');
    expect(prompt).toContain('REWRITTEN_A:');
    expect(prompt).not.toContain('PLAN_A:');
    expect(prompt).not.toContain('ANSWER_A:');
    await inspectNode('PLAN_A:');
    await page.getByRole('button', { name: 'Ask from this node', exact: true }).click();
    await canvasSend(
      'QUESTION_CHILD: 保留原问题，另外考虑雨天。',
      'QUESTION_CHILD_REPLY: 原问题仍是背景。',
    );
    prompt = await lastPrompt();
    expect(prompt).toContain('PLAN_A:');
    expect(prompt).not.toContain('ANSWER_A:');
    expect(prompt).not.toContain('REWRITTEN_A:');
  });

  await test.step('original stop control remains effective after the changes', async () => {
    await page.getByRole('button', { name: 'Chat', exact: true }).click();
    await expect(
      page.getByText('QUESTION_CHILD_REPLY: 原问题仍是背景。', { exact: true }),
    ).toBeVisible();
    await fixture('DELAYED_RESPONSE', true);
    const count = (await outbound()).length;
    await page
      .getByRole('textbox', { name: 'Message input', exact: true })
      .fill('STOP_PROBE: pause this request.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await outbound()).length).toBe(count + 1);
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Stop generating', exact: true }),
    ).not.toBeVisible();
    await page.request.post('http://127.0.0.1:8889/__e2e/release');
    await chatSend('AFTER_STOP: 可以正常继续提问。', 'AFTER_STOP_REPLY: 停止后恢复正常。');
  });

  await test.step('original text upload is stored and reaches the model', async () => {
    await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'From Local Computer', exact: true }).click();
    const upload = page.waitForResponse(
      (response) => response.url().includes('/api/files') && response.request().method() === 'POST',
    );
    await (
      await chooser
    ).setFiles({
      name: 'canvas-check.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{"FILE_MARKER":"Original file upload still reaches the provider"}'),
    });
    expect((await upload).ok()).toBeTruthy();
    await chatSend('FILE_QUESTION: 阅读上传的测试文件。', 'FILE_REPLY: 文件流程仍然可用。');
    expect(await lastPrompt()).toContain('FILE_MARKER');
    const saved = (await messages()).find((message) => message.text.startsWith('FILE_QUESTION:'));
    expect(saved?.files?.some((file) => file.filename === 'canvas-check.json')).toBe(true);
  });
  await test.step('reading preference persists; desktop keyboard interaction preserves drafts', async () => {
    await openCanvas();
    await expect(page.getByRole('combobox', { name: 'Reading mode' })).toHaveValue('side');
    await page.getByRole('combobox', { name: 'Reading mode' }).selectOption('dialog');
    await page.reload();
    await openCanvas();
    await expect(page.getByRole('combobox', { name: 'Reading mode' })).toHaveValue('dialog');
    const node = page
      .locator('.react-flow__node')
      .filter({ hasText: 'PLAN_A:' })
      .getByRole('button');
    await node.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toContainText('PLAN_A:');
    await page.keyboard.press('Tab');
    expect(
      await page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(
      await page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(node).toBeFocused();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCSS('animation-name', 'none');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Ask from this node', exact: true })
      .click();
    const input = page.getByRole('textbox', { name: 'New question', exact: true });
    await expect(input).toBeFocused();
    await input.fill('KEYBOARD_DRAFT');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(input).toHaveValue('KEYBOARD_DRAFT');
    await expect(input).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Ask on new branch', exact: true }),
    ).toBeDisabled();
    await page.getByRole('combobox', { name: 'Reading mode' }).selectOption('side');
    await page.getByRole('button', { name: 'Fit all messages in view', exact: true }).click();
    await page.getByRole('checkbox', { name: /Use as context ANSWER_A:/ }).check();
    await page.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: /Use as context ANSWER_A:/ }),
    ).not.toBeChecked();
    await expect(input).toHaveValue('KEYBOARD_DRAFT');
    await expect(input).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await inspectNode('PLAN_A:');
    await page.getByRole('button', { name: 'Ask from this node', exact: true }).click();
    await input.fill('KEYBOARD_QUESTION: 保留换行与中文输入。');
    const count = (await outbound()).length;
    await input.press('Enter');
    await expect(input).toHaveValue('KEYBOARD_QUESTION: 保留换行与中文输入。\n');
    await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
    expect((await outbound()).length).toBe(count);
    await fixture('KEYBOARD_REPLY: 快捷键只发送一次。');
    await input.press('Control+Enter');
    await waitSaved('KEYBOARD_REPLY:');
    expect((await outbound()).length).toBe(count + 1);
  });
  await page.context().storageState({ path: '/tmp/chatgit-browser-state.json' });
  writeFileSync('/tmp/chatgit-browser-url', page.url());
});
