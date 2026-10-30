const { test, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
let server, baseURL, context, page, panel, worker, tabId, copy;
let external, errors;
const id = (prefix) => `${prefix}_${require('node:crypto').randomUUID().replace(/-/g, '')}`;
test.beforeAll(async () => {
  const { build } = await import(pathToFileURL(path.resolve(__dirname,'../apps/extension/node_modules/vite/dist/node/index.js')).href);
  const bundled = await build({configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},resolve:{alias:{react:path.resolve(__dirname,'../apps/extension/node_modules/react'),'react-dom':path.resolve(__dirname,'../apps/extension/node_modules/react-dom')}},build:{write:false,minify:true,lib:{entry:path.join(__dirname,'fixtures/controlled-form.tsx'),formats:['iife'],name:'PikoControlledFixture'}}});
  const reactFixture = (Array.isArray(bundled)?bundled:[bundled]).flatMap(bundle=>bundle.output).find(output=>output.type==='chunk').code;
  server = http.createServer((request, response) => {
    if(request.url === '/controlled-form.js') { response.setHeader('Content-Type','text/javascript');response.end(reactFixture);return; }
    if(request.url !== '/form-fixture.html') { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type','text/html');
    response.end(fs.readFileSync(path.join(__dirname,'fixtures/form-fixture.html')));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  baseURL=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{ if(server) await new Promise(resolve=>server.close(resolve)); });
test.beforeEach(async()=>{
  external=[];errors=[];
  // Only this isolated test copy has loopback host access. Production still
  // requires a toolbar activeTab grant and has no website host permissions.
  copy=fs.mkdtempSync(path.join(os.tmpdir(),'piko-fill-test-'));
  fs.cpSync(path.resolve(__dirname,'../apps/extension/dist'),copy,{recursive:true});
  const manifestPath=path.join(copy,'manifest.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.host_permissions=['http://127.0.0.1/*'];
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,executablePath:process.env.PIKO_CHROMIUM_PATH||undefined,args:[`--disable-extensions-except=${copy}`,`--load-extension=${copy}`]});
  context.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(baseURL)) external.push(request.url());});
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  page=await context.newPage();await page.goto(`${baseURL}/form-fixture.html`);
  panel=await context.newPage();
  panel.on('pageerror',error=>errors.push(error.message));
  await panel.setViewportSize({width:360,height:800});
  await panel.goto(`chrome-extension://${new URL(worker.url()).hostname}/src/sidepanel/index.html`);
  await page.bringToFront();
  tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,`${baseURL}/form-fixture.html`);
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{
    globalThis.__pikoDangerous=[];
    for(const [prototype,names] of [[HTMLFormElement.prototype,['submit','requestSubmit']],[HTMLElement.prototype,['click']]]) {
      for(const name of names) prototype[name]=function(){globalThis.__pikoDangerous.push(name);throw Error('Forbidden automatic interaction');};
    }
  }}),tabId);
});
test.afterEach(async()=>{
  try {
    expect(external).toEqual([]); expect(errors).toEqual([]);
    if(page&&!page.isClosed()) expect(await page.evaluate(()=>window.fixtureEvents?.submit??0)).toBe(0);
    if(worker&&page&&!page.isClosed()) {
      const calls=await worker.evaluate(async tabId=>(await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>globalThis.__pikoDangerous??[]}))[0].result,tabId);
      expect(calls).toEqual([]);
    }
  } finally {
    await context?.close();
    const resolved=path.resolve(copy);
    if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('piko-fill-test-')) throw Error('Unexpected cleanup target');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});
const send=message=>panel.evaluate(message=>chrome.runtime.sendMessage(message),message);
async function scan(){ const response=await send({type:'PIKO_SCAN_ACTIVE',requestId:id('request')}); expect(response.ok).toBe(true); return response.result; }
const field=(scan,label)=>scan.inventory.forms.flatMap(form=>form.fields).find(field=>field.label===label);
const instruction=(scan,label,target,overwriteExisting=true)=>({fieldId:field(scan,label).fieldId,target,overwriteExisting});
async function review(scan,items){return send({type:'PIKO_FILL_REVIEW',tabId:scan.tabId,scanId:scan.inventory.scanId,items});}
async function apply(scan,items){const checked=await review(scan,items);expect(checked.ok,JSON.stringify(checked)).toBe(true);return send({type:'PIKO_FILL_APPROVE',reviewId:checked.reviewId});}
async function prepareEngine(scan,items){const checked=await review(scan,items);expect(checked.ok,JSON.stringify(checked)).toBe(true);}
function authorization(scan,items){return {tabId:scan.tabId,scanId:scan.inventory.scanId,documentId:scan.inventory.documentId,origin:scan.inventory.origin,batchId:id('batch'),issuedAt:Date.now(),expiresAt:Date.now()+9000,items:items.map(item=>({...item,formId:scan.inventory.forms.find(form=>form.fields.some(field=>field.fieldId===item.fieldId)).formId}))};}
const commitFromWorker=authorization=>worker.evaluate(async({tabId,authorization})=>chrome.tabs.sendMessage(tabId,{type:'PIKO_FILL_COMMIT',authorization},{frameId:0}),{tabId,authorization});

test('all nine supported controls fill exact manual values, bubble events, and leave unapproved fields untouched',async()=>{
  const current=await scan();
  const department=field(current,'Department'); const radio=field(current,'Preferred channel');
  const items=[
    instruction(current,'Full name',{kind:'text',value:'Alex Thomas'}),
    instruction(current,'Email address',{kind:'email',value:'alex@example.test'}),
    instruction(current,'Telephone',{kind:'tel',value:'+1 555 0100'}),
    instruction(current,'Quantity',{kind:'number',value:'3.5'}),
    instruction(current,'Start date',{kind:'date',value:'2026-11-15'}),
    instruction(current,'Biography',{kind:'textarea',value:'Synthetic\nbiography'}),
    instruction(current,'Department',{kind:'select',optionId:department.options.find(option=>option.label==='Design').optionId}),
    instruction(current,'Preferred channel',{kind:'radio',optionId:radio.options.find(option=>option.label==='Phone').optionId}),
    instruction(current,'Has a laptop',{kind:'checkbox',checked:false}),
  ];
  const checked=await review(current,items); expect(checked.ok,JSON.stringify(checked)).toBe(true);
  expect(await page.locator('#full-name').inputValue()).toBe('PRIVATE_EXISTING_NAME_901');
  expect(await page.evaluate(()=>window.fixtureEvents)).toEqual({input:0,change:0,submit:0});
  const result=await send({type:'PIKO_FILL_APPROVE',reviewId:checked.reviewId});
  expect(result.ok,JSON.stringify(result)).toBe(true);expect(result.result.status).toBe('completed');
  expect(result.result.results.every(item=>item.status==='filled')).toBe(true);
  expect(await page.locator('#full-name').inputValue()).toBe('Alex Thomas');
  expect(await page.locator('[name=email]').inputValue()).toBe('alex@example.test');
  expect(await page.locator('[type=tel]').inputValue()).toBe('+1 555 0100');
  expect(await page.locator('#quantity').inputValue()).toBe('3.5');
  expect(await page.locator('#date').inputValue()).toBe('2026-11-15');
  expect(await page.locator('textarea').inputValue()).toBe('Synthetic\nbiography');
  expect(await page.locator('#department option:checked').textContent()).toBe('Design');
  await expect(page.locator('input[name=channel]').nth(1)).toBeChecked();
  await expect(page.locator('[name=hasLaptop]')).not.toBeChecked();
  await expect(page.locator('[name=termsConsent]')).toBeChecked();
  expect(await page.locator('#organization').inputValue()).toBe('');
  expect(await page.locator('[type=password]').inputValue()).toBe('PRIVATE_PASSWORD_916');
  expect(await page.evaluate(()=>window.fixtureEvents)).toEqual({input:9,change:9,submit:0});
  expect(JSON.stringify(result)).not.toMatch(/Alex|Synthetic|example.test|PRIVATE_|RAW_/);
  expect((await send({type:'PIKO_FILL_APPROVE',reviewId:checked.reviewId})).ok).toBe(false);
});

test('native constraints reject entire batches before insertion, including normalization and invalid option IDs',async()=>{
  const current=await scan();
  const good=instruction(current,'Organization',{kind:'text',value:'Synthetic Org'},false);
  for(const [label,target] of [
    ['Quantity',{kind:'number',value:'99'}],['Quantity',{kind:'number',value:'2.2'}],['Quantity',{kind:'number',value:'NaN'}],
    ['Start date',{kind:'date',value:'2026-02-30'}],['Start date',{kind:'date',value:'2025-01-01'}],
    ['Email address',{kind:'email',value:'invalid email'}],['Full name',{kind:'text',value:'A'}],['Full name',{kind:'text',value:'Alex 123'}],
    ['Telephone',{kind:'tel',value:'hello\nthere'}],['Department',{kind:'select',optionId:id('opt')}],
    ['Full name',{kind:'checkbox',checked:true}],
  ]) { const response=await review(current,[good,instruction(current,label,target)]);expect(response.ok,`${label} ${JSON.stringify(target)}`).toBe(false); }
  expect(await page.locator('#organization').inputValue()).toBe('');
  expect(await page.evaluate(()=>window.fixtureEvents)).toEqual({input:0,change:0,submit:0});
});

test('existing answers require separate overwrite permission, and already-matched values emit no events',async()=>{
  const current=await scan();
  const proposed=instruction(current,'Full name',{kind:'text',value:'Alex Thomas'},false);
  const blocked=await review(current,[proposed]);expect(blocked.ok).toBe(false);expect(blocked.preflight.results[0].reason).toBe('existing-value');
  const matched=instruction(current,'Quantity',{kind:'number',value:'7'},false);
  const response=await apply(current,[matched]);expect(response.result.results[0].status).toBe('already-matched');
  expect(await page.evaluate(()=>window.fixtureEvents)).toEqual({input:0,change:0,submit:0});
  expect((await apply(current,[{...proposed,overwriteExisting:true}])).result.status).toBe('completed');
});

test('live value conflicts and replacement or ineligible controls are rejected at commit',async()=>{
  let current=await scan();
  const item=instruction(current,'Organization',{kind:'text',value:'Approved organization'},false);
  const reviewed=await review(current,[item]);expect(reviewed.ok).toBe(true);
  await page.locator('#organization').evaluate(element=>element.value='User typed meanwhile');
  const blocked=await send({type:'PIKO_FILL_APPROVE',reviewId:reviewed.reviewId});expect(blocked.result.status).toBe('rejected');expect(blocked.result.results[0].reason).toBe('existing-value');
  expect(await page.locator('#organization').inputValue()).toBe('User typed meanwhile');
  for(const change of ['replace','hidden','disabled','type','form','option']) {
    current=await scan();const proposal=instruction(current,'Full name',{kind:'text',value:'Alex Thomas'});const check=await review(current,[proposal]);expect(check.ok).toBe(true);
    await page.evaluate(change=>{
      const node=document.getElementById('full-name');
      if(change==='replace')node.replaceWith(node.cloneNode(true));
      if(change==='hidden')node.hidden=true;
      if(change==='disabled')node.disabled=true;
      if(change==='type')node.type='password';
      if(change==='form')node.setAttribute('form','other-form');
      if(change==='option')document.querySelector('#department option').textContent='Changed';
    },change);
    const result=await send({type:'PIKO_FILL_APPROVE',reviewId:check.reviewId});expect(result.ok===false||result.result.status==='rejected').toBe(true);
    await page.goto(`${baseURL}/form-fixture.html`);
  }
});

test('expired, reused, wrong-origin, wrong-document, wrong-tab, unknown-form and unknown-field grants cannot mutate',async()=>{
  const current=await scan();const items=[instruction(current,'Organization',{kind:'text',value:'Approved Org'},false)];
  await prepareEngine(current,items);
  const valid=authorization(current,items);
  for(const change of [
    {batchId:id('batch'),issuedAt:Date.now()-20000,expiresAt:Date.now()-15000},
    {batchId:id('batch'),origin:'https://other.test'}, {batchId:id('batch'),documentId:id('doc')}, {batchId:id('batch'),scanId:id('scan')}, {batchId:id('batch'),tabId:999},
    {batchId:id('batch'),items:[{...valid.items[0],formId:id('frm')}]}, {batchId:id('batch'),items:[{...valid.items[0],fieldId:id('fld')}]},
  ]) { const result=await commitFromWorker({...valid,...change});expect(result.status,JSON.stringify(result)).toBe('rejected'); }
  expect(await page.locator('#organization').inputValue()).toBe('');
  // Panel-to-content messages are not worker authorization, even with a valid schema.
  const spoof=await panel.evaluate(async({tabId,authorization})=>{try{return await chrome.tabs.sendMessage(tabId,{type:'PIKO_FILL_COMMIT',authorization},{frameId:0});}catch{return null;}},{tabId,authorization:valid});
  expect(spoof).toBeFalsy();expect(await page.locator('#organization').inputValue()).toBe('');
  const result=await commitFromWorker(valid);expect(result.status,JSON.stringify(result)).toBe('completed');
  expect((await commitFromWorker(valid)).results[0].reason).toBe('replayed');
});

test('page-side reversion, replacement, later-field side effects and custom validity are accurately reported',async()=>{
  await page.evaluate(()=>{
    document.getElementById('organization').addEventListener('input',event=>{setTimeout(()=>{event.target.value='Page restored';},20);});
  });
  let current=await scan();let result=await apply(current,[instruction(current,'Organization',{kind:'text',value:'Approved Org'},false)]);
  expect(result.result.status).toBe('partial');expect(result.result.results[0].reason).toBe('page-reverted');
  await page.goto(`${baseURL}/form-fixture.html`);
  await page.evaluate(()=>document.getElementById('organization').addEventListener('input',event=>event.target.replaceWith(event.target.cloneNode(true))));
  current=await scan();result=await apply(current,[instruction(current,'Organization',{kind:'text',value:'Approved Org'},false)]);
  expect(result.result.status).toBe('partial');expect(result.result.results[0].reason).toBe('page-changed');
  await page.goto(`${baseURL}/form-fixture.html`);
  await page.evaluate(()=>document.getElementById('organization').addEventListener('input',()=>document.getElementById('full-name').value='Page changed earlier field'));
  current=await scan();result=await apply(current,[instruction(current,'Full name',{kind:'text',value:'Alex Thomas'}),instruction(current,'Organization',{kind:'text',value:'Approved Org'},false)]);
  expect(result.result.status).toBe('partial');expect(result.result.results[0].reason).toBe('page-reverted');expect(result.result.results[1].status).toBe('filled');
  await page.goto(`${baseURL}/form-fixture.html`);
  await page.evaluate(()=>document.getElementById('organization').setCustomValidity('Website rejects this field'));
  current=await scan();expect((await review(current,[instruction(current,'Organization',{kind:'text',value:'Approved Org'},false)])).ok).toBe(false);
});

test('React controlled forms retain recognized events and report controlled-state reversion',async()=>{
  await page.evaluate(()=>{
    const root=document.createElement('div');root.id='react-root';document.body.append(root);
    const script=document.createElement('script');script.src='/controlled-form.js';document.body.append(script);
  });
  await expect(page.locator('#react-answer')).toBeVisible();
  const current=await scan();
  const result=await apply(current,[instruction(current,'React answer',{kind:'text',value:'Recognized React answer'},false),instruction(current,'React fixed answer',{kind:'text',value:'Rejected React answer'},true)]);
  expect(result.result.status).toBe('partial');
  expect(result.result.results[0].status).toBe('filled');expect(result.result.results[1].reason).toBe('page-reverted');
  expect(await page.locator('#react-state').textContent()).toBe('Recognized React answer');
  expect(await page.locator('#react-fixed').inputValue()).toBe('Original');
});
