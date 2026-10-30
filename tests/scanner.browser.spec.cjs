const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

let server;
let baseURL;
let context;
let worker;
let page;
let panel;
let tabId;
let temporaryExtension;
let extensionId;
let externalRequests;
let panelErrors;
const production = path.resolve(__dirname, '../apps/extension/dist');

test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://localhost').pathname;
    if (!['/form-fixture.html', '/empty-fixture.html'].includes(filename)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(__dirname, 'fixtures', filename.slice(1))));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function launch(fixtureAccess) {
  let extensionPath = production;
  if (fixtureAccess) {
    // Headless Chrome cannot click its native toolbar to grant activeTab.
    // Grant only loopback access in an isolated TEST COPY, never the real build.
    temporaryExtension = fs.mkdtempSync(path.join(os.tmpdir(), 'piko-scanner-test-'));
    fs.cpSync(production, temporaryExtension, { recursive: true });
    const manifestPath = path.join(temporaryExtension, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.host_permissions = ['http://127.0.0.1/*'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    extensionPath = temporaryExtension;
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, executablePath: process.env.PIKO_CHROMIUM_PATH || undefined,
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  externalRequests = []; panelErrors = [];
  context.on('request', (request) => { if (/^https?:/.test(request.url()) && !request.url().startsWith(baseURL)) externalRequests.push(request.url()); });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).hostname;
  page = await context.newPage();
  await page.goto(`${baseURL}/form-fixture.html`);
  panel = await context.newPage();
  panel.on('pageerror', (error) => panelErrors.push(error.message));
  panel.on('console', (message) => { if (message.type() === 'error') panelErrors.push(message.text()); });
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await page.bringToFront();
  tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, `${baseURL}/form-fixture.html`);
}

test.afterEach(async () => {
  try { expect(externalRequests).toEqual([]); expect(panelErrors).toEqual([]); }
  finally {
    await context?.close(); context = undefined;
    if (temporaryExtension) { fs.rmSync(temporaryExtension, { recursive: true, force: true }); temporaryExtension = undefined; }
  }
});

async function requestScan() {
  await page.bringToFront();
  return panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'PIKO_SCAN_ACTIVE', requestId: `request_${crypto.randomUUID().replace(/-/g, '')}` }));
}
async function installPrivacyTripwires() {
  await worker.evaluate(async (id) => chrome.scripting.executeScript({
    target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', func: () => {
      globalThis.__pikoForbidden = [];
      for (const [prototype, keys] of [[HTMLInputElement.prototype, ['value', 'checked']], [HTMLTextAreaElement.prototype, ['value']], [HTMLSelectElement.prototype, ['value', 'selectedIndex']], [HTMLOptionElement.prototype, ['value', 'selected']]]) {
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          Object.defineProperty(prototype, key, {
            configurable: true,
            get() { globalThis.__pikoForbidden.push(`read:${key}`); throw new Error('Existing answer read'); },
            set() { globalThis.__pikoForbidden.push(`write:${key}`); throw new Error('Answer write'); },
            enumerable: descriptor.enumerable,
          });
        }
      }
      globalThis.fetch = () => { globalThis.__pikoForbidden.push('fetch'); throw new Error('Network request'); };
      Storage.prototype.setItem = () => { globalThis.__pikoForbidden.push('storage'); throw new Error('Persistence'); };
      HTMLFormElement.prototype.submit = () => { globalThis.__pikoForbidden.push('submit'); throw new Error('Form submission'); };
      HTMLFormElement.prototype.requestSubmit = () => { globalThis.__pikoForbidden.push('requestSubmit'); throw new Error('Form submission'); };
    },
  }), tabId);
}
async function forbiddenCalls() {
  return worker.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, world: 'ISOLATED', func: () => globalThis.__pikoForbidden }))[0].result, tabId);
}
function fields(response) { return response.result.inventory.forms.flatMap((form) => form.fields); }

test('production permissions require activeTab and reject restricted pages',async()=>{
 const manifest=JSON.parse(fs.readFileSync(path.join(production,'manifest.json'),'utf8'));expect(manifest.permissions).toEqual(['sidePanel','activeTab','scripting','storage']);expect(manifest.host_permissions).toEqual(['http://127.0.0.1:8765/*']);expect(manifest.content_scripts).toBeUndefined();await launch(false);expect((await requestScan()).ok).toBe(false);await page.goto('chrome://version');const result=await requestScan();expect(result.ok).toBe(false);expect(['unsupported-page','activate-extension']).toContain(result.error);
});
test('real packaged injection returns correct metadata without reading values, writing or submitting', async ({}, testInfo) => {
  await launch(true);
  await installPrivacyTripwires();
  const before = await page.locator('body').innerHTML();
  const result = await requestScan();
  expect(result.ok).toBe(true);
  const all = fields(result);
  expect(new Set(all.map((field) => field.fieldType))).toEqual(new Set(['text', 'email', 'tel', 'number', 'date', 'textarea', 'select', 'radio', 'checkbox']));
  const byLabel = (label) => all.find((field) => field.label === label);
  expect(byLabel('Full name').constraints).toEqual({ minLength: 2, maxLength: 100, patternPresent: true });
  expect(byLabel('Email address').labelSource).toBe('aria-labelledby');
  expect(byLabel('Telephone').labelSource).toBe('aria-label');
  expect(byLabel('Biography').fieldType).toBe('textarea');
  expect(byLabel('Quantity').constraints).toMatchObject({ min: '1', max: '12', step: '0.5' });
  expect(byLabel('Department').options.map((option) => option.label)).toEqual(['Choose a department', 'Engineering', 'Design', 'Archive']);
  expect(byLabel('Department').options.at(-1).disabled).toBe(true);
  const radios = all.filter((field) => field.fieldType === 'radio');
  expect(radios).toHaveLength(2);
  expect(radios[0].label).toBe('Preferred channel'); expect(radios[0].options).toHaveLength(3);
  expect(radios[1].options.map((option) => option.label)).toEqual(['Email', 'Email']);
  expect(byLabel('I agree to the terms and privacy policy').exclusionReasons).toContain('consent');
  expect(byLabel('Disabled answer').eligible).toBe(false);
  expect(byLabel('Disabled by fieldset').enabled).toBe(false);
  expect(byLabel('Read-only answer').eligible).toBe(false);
  expect(byLabel('reference Code').labelUncertain).toBe(true);
  expect(byLabel('Preferred nickname').labelSource).toBe('placeholder');
  expect(all.filter((field) => field.eligible).every((field) => field.visible && field.enabled && !field.readOnly && !field.labelUncertain)).toBe(true);
  expect(result.result.inventory.exclusions).toMatchObject({ hidden: 4, sensitive: 4, disabled: 2, readOnly: 1, consent: 1, uncertainLabel: 2 });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toMatch(/PRIVATE_|RAW_OPTION_|RAW_RADIO_|RAW_SECOND_|Unrelated page text|Ambiguous nearby text/);
  const identifiers = [result.result.inventory.scanId, result.result.inventory.documentId, ...result.result.inventory.forms.flatMap((form) => [form.formId, ...form.fields.flatMap((field) => [field.fieldId, ...field.options.map((option) => option.optionId)])])];
  expect(new Set(identifiers).size).toBe(identifiers.length);
  expect(identifiers.every((id) => /^[a-z]+_[a-f0-9]{32}$/.test(id))).toBe(true);
  expect(await forbiddenCalls()).toEqual([]);
  expect(await page.locator('body').innerHTML()).toBe(before);
  expect(await page.evaluate(() => window.fixtureEvents)).toEqual({ input: 0, change: 0, submit: 0 });
  const again = await requestScan();
  expect(fields(again).map((field) => field.fieldId)).toEqual(all.map((field) => field.fieldId));
  expect(again.result.inventory.scanId).not.toBe(result.result.inventory.scanId);
  for (const width of [280, 360, 480]) {
    await panel.setViewportSize({ width, height: 800 });
    expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await panel.setViewportSize({ width: 360, height: 800 });
  await panel.screenshot({ path: testInfo.outputPath('scanner-inventory.png'), fullPage: true });
});


async function current(scan){return worker.evaluate(async({tabId,scanId,documentId})=>{try{return(await chrome.tabs.sendMessage(tabId,{type:'PIKO_SCAN_CURRENT',scanId,documentId},{frameId:0})).current;}catch{return false;}},{tabId,scanId:scan.result.inventory.scanId,documentId:scan.result.inventory.documentId});}
test('mutations invalidate registries and replacement controls receive fresh IDs',async()=>{await launch(true);const first=await requestScan(),before=fields(first).find(f=>f.label==='Full name').fieldId;await page.locator('#full-name').evaluate(e=>e.replaceWith(e.cloneNode(true)));await expect.poll(()=>current(first)).toBe(false);const second=await requestScan();expect(fields(second).find(f=>f.label==='Full name').fieldId).not.toBe(before);});
test('navigation invalidates metadata and empty pages return empty inventories',async()=>{await launch(true);const first=await requestScan();await page.goto(baseURL+'/empty-fixture.html');await expect.poll(()=>current(first)).toBe(false);const empty=await requestScan();expect(empty.ok).toBe(true);expect(fields(empty)).toEqual([]);});
test('the real production action grants activeTab and scans without test host permissions', async () => {
  await launch(false);
  const browserSession = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{}] });
  const tabTarget = targetInfos.find((target) => target.type === 'tab' && target.url === page.url());
  expect(tabTarget, JSON.stringify(targetInfos.map(({ type, url }) => ({ type, url })))).toBeTruthy();
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
  const result = await requestScan();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(fields(result).find((field) => field.label === 'Full name')).toBeTruthy();
});


test('a panel can explicitly scan its own window while another window is focused',async()=>{await launch(true);const owner=await worker.evaluate(async id=>(await chrome.tabs.get(id)).windowId,tabId);const other=await worker.evaluate(async url=>chrome.windows.create({url,focused:true}),baseURL+'/empty-fixture.html');const result=await panel.evaluate(async windowId=>chrome.runtime.sendMessage({type:'PIKO_SCAN_ACTIVE',windowId,requestId:`request_${crypto.randomUUID().replace(/-/g,'')}`}),owner);expect(result.ok).toBe(true);expect(fields(result).find(f=>f.label==='Full name')).toBeTruthy();await worker.evaluate(async id=>chrome.windows.remove(id),other.id);});
