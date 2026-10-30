const assert=require('node:assert/strict');
const path=require('node:path');
const {test}=require('node:test');
const createLoader=require('./helpers/load-typescript.cjs');
const root=path.resolve(__dirname,'../apps/extension/src');
const load=createLoader();
const {AssistantOrchestrator}=load(path.join(root,'features/assistant/assistant.orchestrator.ts'));
const {initialWorkflow,workflowReducer}=load(path.join(root,'features/assistant/workflow.reducer.ts'));
const {canTransition,canApprove}=load(path.join(root,'features/assistant/workflow-guards.ts'));
const {questionQueue}=load(path.join(root,'features/assistant/question-queue.ts'));
const {relevantFacts,reusableDrafts,validDraft}=load(path.join(root,'features/assistant/conversation-selectors.ts'));
const {factKey,factValue,isSessionSnapshot}=load(path.join(root,'features/assistant/session-facts.validation.ts'));
const {FACT_TTL_MS,WORKFLOW_SESSION_KEY}=load(path.join(root,'features/assistant/session-facts.types.ts'));
const id=(prefix,n)=>`${prefix}_${n.toString(16).padStart(32,'0')}`;
const field=(n,label,type='text',required=true)=>({fieldId:id('field',n),label,labelSource:'label',labelUncertain:false,fieldType:type,required,visible:true,enabled:true,readOnly:false,eligible:true,exclusionReasons:[],options:[],constraints:{}});
const fields=[field(1,'Full name'),field(2,'Email address','email')];
function scan(list=fields,n=1){return{tabId:7,inventory:{version:1,scanId:id('scan',n),documentId:id('document',1),origin:'https://form.test',forms:[{formId:id('form',1),label:'Synthetic form',fields:list}],exclusions:{hidden:0,sensitive:0,unsupported:0,disabled:0,readOnly:0,consent:0,uncertainLabel:0},limitations:['top-frame-only'],truncated:false}};}
function session(){const now=Date.now();return{sessionId:id('session',1),createdAt:now,expiresAt:now+FACT_TTL_MS,origin:'https://form.test',version:1,facts:[]};}
function response(request,values={},clarifications=[]){return{scanId:request.scanId,updates:request.fields.filter(f=>values[f.fieldId]!==undefined).map(f=>({fieldId:f.fieldId,target:{kind:f.type,value:values[f.fieldId]},evidence:{source:'transcript',factId:null,quote:request.transcript}})),clarifications,missingFields:request.fields.filter(f=>f.required&&values[f.fieldId]===undefined).map(f=>({fieldId:f.fieldId,question:`What should I enter for ${f.label}?`}))};}
function setup(overrides={}){
 let current=session(),snapshot=scan(),nextValues={},nextClarifications=[];
 const calls={interpret:[],fill:[],cancel:[],speech:[],clear:[]};
 const deps={scan:async()=>snapshot,stopScan:async()=>{},ensure:async()=>current,status:async()=>current,clear:async sid=>{calls.clear.push(sid);current=null;},speak:async text=>calls.speech.push(text),stopSpeech:()=>{},resetVoice:()=>{},cancelReview:async id=>{calls.cancel.push(id);},interpret:async(request,tabId,signal,context)=>{calls.interpret.push({request,tabId,signal,context});return response(request,nextValues,nextClarifications);},fill:async(request,items)=>{calls.fill.push({request,items});return request.type==='PIKO_FILL_REVIEW'?{ok:true,reviewId:id('review',1),expiresAt:Date.now()+60000,preflight:{ok:true,results:items.map(i=>({fieldId:i.fieldId,status:'not-verified'}))}}:{ok:true,result:{batchId:id('batch',1),status:'completed',results:items.map(i=>({fieldId:i.fieldId,status:'filled'}))}};},...overrides};
 const controller=new AssistantOrchestrator(deps);
 return{controller,calls,deps,setValues:values=>{nextValues=values;},setClarifications:value=>{nextClarifications=value;},setScan:value=>{snapshot=value;},setSession:value=>{current=value;}};
}
test('workflow rejects direct mutation transitions and approval without exact review',()=>{
 assert.equal(canTransition('interpreting','filling'),false);assert.equal(canTransition('collecting','filling'),false);assert.equal(canTransition('review','filling'),true);
 const state=initialWorkflow();assert.equal(workflowReducer(state,{type:'FILL_START',token:{},now:Date.now()}),state);assert.equal(canApprove(state),false);
});
test('multi-field answer and multiple turns merge proposals without sending conversation history',async()=>{
 const s=setup();await s.controller.scan();assert.equal(questionQueue(s.controller.snapshot()).length,2);
 s.controller.transcript('My full name is Alex Thomas.');s.setValues({[fields[0].fieldId]:'Alex Thomas'});await s.controller.interpret();
 assert.equal(s.controller.snapshot().stage,'collecting');assert.equal(questionQueue(s.controller.snapshot()).length,1);
 s.controller.transcript('My email address is alex@example.test.');s.setValues({[fields[1].fieldId]:'alex@example.test'});await s.controller.interpret();
 assert.equal(s.controller.snapshot().stage,'review');assert.equal(Object.keys(s.controller.snapshot().drafts).length,2);assert.equal(s.calls.interpret[1].request.transcript,'My email address is alex@example.test.');assert.equal(Object.hasOwn(s.calls.interpret[1].request,'history'),false);
 assert.notEqual(s.calls.interpret[0].context.requestId,s.calls.interpret[1].context.requestId);assert.equal(s.calls.fill.length,0);s.controller.dispose();
});
test('explicit corrections replace prior model values but manual edits stay protected in later turns',async()=>{
 const s=setup();await s.controller.scan();s.controller.transcript('Alex Thomas');s.setValues({[fields[0].fieldId]:'Alex Thomas'});await s.controller.interpret();
 s.controller.edit(fields[0].fieldId,{text:'Manual Person'});s.controller.transcript('New Person and alex@example.test');s.setValues({[fields[0].fieldId]:'New Person',[fields[1].fieldId]:'alex@example.test'});await s.controller.interpret();
 assert.equal(s.controller.snapshot().drafts[fields[0].fieldId].text,'Manual Person');assert.equal(s.controller.snapshot().drafts[fields[1].fieldId].text,'alex@example.test');s.controller.dispose();
});
test('late or superseded model replies cannot replace manual edits, transcripts or a new scan',async()=>{
 let finish;const s=setup({interpret:request=>new Promise(resolve=>{finish=()=>resolve(response(request,{[fields[0].fieldId]:'Alex Thomas'}));})});
 await s.controller.scan();s.controller.transcript('Alex Thomas');const job=s.controller.interpret();await new Promise(setImmediate);
 s.controller.edit(fields[0].fieldId,{text:'Manual correction'});finish();await job;assert.equal(s.controller.snapshot().drafts[fields[0].fieldId].text,'Manual correction');assert.equal(s.controller.snapshot().stage,'collecting');
 s.controller.transcript('Alex Thomas');const second=s.controller.interpret();await new Promise(setImmediate);s.controller.stale();finish();await second;assert.equal(s.controller.snapshot().stage,'stale');assert.equal(s.calls.fill.length,0);s.controller.dispose();
});
test('skips remain unresolved, clarification is bound to the current scan, and partial manual review is possible',async()=>{
 const s=setup();await s.controller.scan();s.controller.skip(fields[0].fieldId);assert.equal(questionQueue(s.controller.snapshot())[0].skipped,true);
 s.controller.edit(fields[1].fieldId,{text:'alex@example.test',selected:true});await s.controller.review();assert.equal(s.controller.snapshot().stage,'review');assert.equal(s.controller.snapshot().approved,false);
 await s.controller.fill();assert.equal(s.calls.fill.length,1);s.controller.approveCheckbox(true);await s.controller.fill();assert.equal(s.calls.fill.length,2);assert.equal(s.controller.snapshot().stage,'results');assert.equal(questionQueue(s.controller.snapshot()).length,1);s.controller.dispose();
});
test('review and memory opt-ins are independent, edits revoke review, and replay is impossible',async()=>{
 const s=setup();await s.controller.scan();s.controller.edit(fields[0].fieldId,{text:'Alex Thomas',selected:true});await s.controller.review();s.controller.rememberCheckbox(true);
 assert.equal(s.controller.snapshot().approved,false);await s.controller.fill();assert.equal(s.calls.fill.length,1);
 s.controller.approveCheckbox(true);s.controller.edit(fields[0].fieldId,{text:'Edited Name'});assert.equal(s.controller.snapshot().review,null);assert.equal(s.controller.snapshot().remember,false);await s.controller.fill();assert.equal(s.calls.fill.length,1);
 await s.controller.review();s.controller.rememberCheckbox(true);s.controller.approveCheckbox(true);await s.controller.fill();assert.equal(s.calls.fill.at(-1).request.rememberSelected,true);assert.equal(s.calls.fill.at(-1).items[0].target.value,'Edited Name');await s.controller.fill();assert.equal(s.calls.fill.length,3);s.controller.dispose();
});
test('staleness during an already authorized fill preserves actual partial outcomes and forces rescan',async()=>{
 let complete;const s=setup({fill:async(request,items)=>request.type==='PIKO_FILL_REVIEW'?{ok:true,reviewId:id('review',1),expiresAt:Date.now()+60000,preflight:{ok:true,results:items.map(i=>({fieldId:i.fieldId,status:'not-verified'}))}}:new Promise(resolve=>{complete=resolve;})});
 await s.controller.scan();s.controller.edit(fields[0].fieldId,{text:'Alex Thomas',selected:true});await s.controller.review();s.controller.approveCheckbox(true);const filling=s.controller.fill();s.controller.stale('changed');
 complete({ok:true,result:{batchId:id('batch',1),status:'partial',results:[{fieldId:fields[0].fieldId,status:'not-verified',reason:'page-reverted'}]}});await filling;
 assert.equal(s.controller.snapshot().stage,'results');assert.equal(s.controller.snapshot().staleReason,'changed');assert.equal(s.controller.snapshot().outcome.status,'partial');await s.controller.review();assert.equal(s.controller.snapshot().review,null);s.controller.dispose();
});
test('model errors and cancellation preserve text, never fill, and support explicit recovery',async()=>{
 const s=setup({interpret:async()=>{throw Error('PRIVATE model failure');}});await s.controller.scan();s.controller.transcript('Synthetic edited text');await s.controller.interpret();
 assert.equal(s.controller.snapshot().stage,'error');assert.equal(s.controller.snapshot().error,'service-unavailable');assert.equal(s.controller.snapshot().transcript,'Synthetic edited text');assert.equal(s.calls.fill.length,0);s.controller.recover();assert.equal(s.controller.snapshot().stage,'collecting');s.controller.dispose();
});
test('old approvals expire and session expiry requires a new session and scan',async()=>{
 const s=setup();await s.controller.scan();s.controller.edit(fields[0].fieldId,{text:'Alex Thomas',selected:true});await s.controller.review();s.controller.approveCheckbox(true);s.controller.expireReview();await s.controller.fill();assert.equal(s.calls.fill.length,1);
 s.setSession(null);await s.controller.refreshSession();assert.equal(s.controller.snapshot().scan,null);assert.equal(s.controller.snapshot().session,null);assert.equal(s.controller.snapshot().drafts[fields[0].fieldId],undefined);s.controller.dispose();
});
test('transcription has its own stage, acceptance never forwards text to Qwen automatically',async()=>{
 const s=setup();await s.controller.scan();s.controller.recordingStage('processing');assert.equal(s.controller.snapshot().stage,'transcribing');s.controller.recordingStage('transcript-ready');s.controller.transcript('Edited voice answer');assert.equal(s.controller.snapshot().stage,'collecting');assert.equal(s.calls.interpret.length,0);s.controller.dispose();
});
function storeSetup(){const data={},levels=[];let now=Date.now();const chrome={storage:{session:{setAccessLevel:async level=>levels.push(level),get:async key=>({[key]:structuredClone(data[key])}),set:async values=>Object.assign(data,structuredClone(values)),remove:async key=>{delete data[key];}}}};const loader=createLoader({chrome});const{SessionFactsStore}=loader(path.join(root,'features/assistant/session-facts.store.ts'));const store=new SessionFactsStore(()=>now);return{store,data,levels,SessionFactsStore,advance:ms=>now+=ms};}
test('session storage contains only explicitly confirmed eligible facts and minimal metadata',async()=>{
 const s=storeSetup();const session=await s.store.ensure('https://form.test');assert.deepEqual(session.facts,[]);
 const context={sessionId:session.sessionId,sessionVersion:session.version,revision:1};const item={fieldId:fields[0].fieldId,target:{kind:'text',value:'Alex Thomas'},overwriteExisting:false};
 const saved=await s.store.remember(context,session.origin,fields,[item]);assert.equal(saved.saved,1);assert.equal(saved.session.facts[0].value,'Alex Thomas');assert.equal(isSessionSnapshot(saved.session),true);
 assert.deepEqual(Object.keys(s.data),[WORKFLOW_SESSION_KEY]);assert.equal(JSON.stringify(s.data).includes('transcript'),false);assert.equal(JSON.stringify(s.data).includes('reviewId'),false);assert.equal(JSON.stringify(s.data).includes('approvedProposals'),false);assert.equal(s.levels.every(level=>level.accessLevel==='TRUSTED_CONTEXTS'),true);
});
test('worker reconstruction retains facts, browser reset does not; expiry, origin changes and clear remove reuse',async()=>{
 const s=storeSetup();const session=await s.store.ensure('https://form.test');await s.store.remember({sessionId:session.sessionId,sessionVersion:1,revision:0},session.origin,fields,[{fieldId:fields[0].fieldId,target:{kind:'text',value:'Alex Thomas'},overwriteExisting:false}]);
 const restarted=new s.SessionFactsStore();assert.equal((await restarted.status()).facts.length,1);
 const empty=storeSetup();assert.equal(await empty.store.status(),null);
 s.advance(FACT_TTL_MS+1);assert.equal(await s.store.status(),null);assert.equal(s.data[WORKFLOW_SESSION_KEY],undefined);
 const next=await s.store.ensure('https://other.test');assert.deepEqual(next.facts,[]);assert.notEqual(next.sessionId,session.sessionId);await s.store.clear(next.sessionId);assert.equal(await s.store.status(),null);
});
test('clear cannot be undone by a stale queued remember and malformed data is discarded',async()=>{
 const s=storeSetup(),session=await s.store.ensure('https://form.test'),context={sessionId:session.sessionId,sessionVersion:1,revision:0};await s.store.clear(session.sessionId);
 assert.equal((await s.store.remember(context,session.origin,fields,[{fieldId:fields[0].fieldId,target:{kind:'text',value:'Alex Thomas'},overwriteExisting:false}])).saved,0);assert.equal(await s.store.status(),null);
 s.data[WORKFLOW_SESSION_KEY]={...session,facts:[{factId:id('fact',1),key:'password',value:'PRIVATE',source:'user_confirmed',confirmedAt:Date.now()}]};assert.equal(await s.store.status(),null);
});
test('sensitive, excluded, consent and unrecognized fields cannot become reusable facts',()=>{
 for(const f of [{...fields[0],eligible:false},{...fields[0],readOnly:true},{...fields[0],label:'Password'},{...fields[0],label:'One time code'},{...fields[0],label:'Credit card number'},{...fields[0],label:'Medical diagnosis'},{...fields[0],fieldType:'checkbox',label:'Consent'}])assert.equal(factKey(f),null);
 assert.equal(factValue(fields[0],{fieldId:fields[0].fieldId,target:{kind:'text',value:'4111 1111 1111 1111'},overwriteExisting:false}),null);
});
test('reused facts remap current option IDs, remain unselected, and never target excluded fields',()=>{
 const s=session();s.facts=[{factId:id('fact',1),key:'department',value:'Computer Science',source:'user_confirmed',confirmedAt:Date.now()}];
 const f={...field(3,'Department','select'),options:[{optionId:id('option',3),label:'Computer Science',disabled:false}]};
 const drafts=reusableDrafts([f,{...f,fieldId:id('field',4),eligible:false}],s);assert.equal(drafts[f.fieldId].text,id('option',3));assert.equal(drafts[f.fieldId].selected,false);assert.equal(drafts[id('field',4)],undefined);
 assert.equal(relevantFacts([f],s).length,1);assert.equal(relevantFacts([fields[0]],s).length,0);
});

test('speech rejection keeps questions usable and transport failures preserve manual recovery',async()=>{
 const s=setup({speak:async()=>{throw Error('PRIVATE voice diagnostic');},fill:async()=>{throw Error('PRIVATE transport diagnostic');}});
 await s.controller.scan();await new Promise(setImmediate);assert.equal(s.controller.snapshot().stage,'collecting');assert.equal(questionQueue(s.controller.snapshot()).length,2);
 s.controller.transcript('Synthetic edited text');s.controller.edit(fields[0].fieldId,{text:'Alex Thomas',selected:true});await s.controller.review();assert.equal(s.controller.snapshot().error,'fill-unavailable');assert.equal(s.controller.snapshot().transcript,'Synthetic edited text');assert.equal(s.controller.snapshot().drafts[fields[0].fieldId].text,'Alex Thomas');s.controller.recover();assert.equal(s.controller.snapshot().stage,'collecting');s.controller.dispose();
});
test('transport loss after approval reports an unknown outcome without retrying the batch',async()=>{
 let commits=0;const s=setup({fill:async(request,items)=>{if(request.type==='PIKO_FILL_REVIEW')return{ok:true,reviewId:id('review',1),expiresAt:Date.now()+60000,preflight:{ok:true,results:items.map(i=>({fieldId:i.fieldId,status:'not-verified'}))}};commits++;throw Error('PRIVATE diagnostic');}});await s.controller.scan();s.controller.edit(fields[0].fieldId,{text:'Alex Thomas',selected:true});await s.controller.review();s.controller.approveCheckbox(true);
 await s.controller.fill();assert.equal(s.controller.snapshot().stage,'error');assert.equal(s.controller.snapshot().error,'fill-unavailable');assert.equal(s.controller.snapshot().review,null);assert.equal(s.controller.snapshot().drafts[fields[0].fieldId].text,'Alex Thomas');await s.controller.fill();assert.equal(commits,1);s.controller.dispose();
});
test('scanning waits for a pending clear so an old clear cannot remove a new session',async()=>{
 let finish,scans=0;const s=setup({clear:()=>new Promise(resolve=>{finish=resolve;}),scan:async()=>{scans++;return scan();}});
 await s.controller.scan();const clearing=s.controller.clearSession();const scanning=s.controller.scan();await new Promise(setImmediate);assert.equal(scans,1);finish();await Promise.all([clearing,scanning]);assert.equal(scans,2);assert.equal(s.controller.snapshot().stage,'collecting');s.controller.dispose();
});
test('purging expired facts invokes invalidation once before any subsequent reuse',async()=>{
 const s=storeSetup();await s.store.ensure('https://form.test');let invalidated=0;const restarted=new s.SessionFactsStore(()=>Date.now()+FACT_TTL_MS+1000,()=>invalidated++);
 assert.equal(await restarted.status(),null);assert.equal(invalidated,1);assert.equal(await restarted.status(),null);assert.equal(invalidated,1);assert.equal(s.data[WORKFLOW_SESSION_KEY],undefined);
});
test('a delayed session refresh cannot erase a replacement scan or restore facts after clear',async()=>{
 const s=setup();await s.controller.scan();let complete;const pending=[];const original=s.deps.status;
 const controller=new AssistantOrchestrator({...s.deps,status:()=>new Promise(resolve=>pending.push(resolve))});
 const restoring=controller.restore();pending.shift()(session());await restoring;
 const refreshing=controller.refreshSession();const scanning=controller.scan();assert.equal(pending.length,2);pending.shift()(null);await refreshing;assert.equal(controller.snapshot().stage,'scanning');pending.shift()(await original());await scanning;assert.equal(controller.snapshot().stage,'collecting');
 const refresh=controller.refreshSession();complete=pending.shift();await controller.clearSession();complete(session());await refresh;assert.equal(controller.snapshot().session,null);assert.equal(controller.snapshot().stage,'idle');controller.dispose();s.controller.dispose();
});
test('invalid dates and out-of-range numbers remain missing required answers',async()=>{
 const draft=text=>({text,selected:false,overwrite:false,source:'manual',protected:true});
 const number={...field(8,'Age','number'),constraints:{min:'18',max:'100'}},date={...field(9,'Date','date'),constraints:{min:'2024-01-01',max:'2024-12-31'}};
 for(const value of ['NaN','1e999','17','101'])assert.equal(validDraft(number,draft(value)),false);assert.equal(validDraft(number,draft('18')),true);
 for(const value of ['2024-02-30','2023-02-29','2025-01-01','0000-01-01'])assert.equal(validDraft(date,draft(value)),false);assert.equal(validDraft(date,draft('2024-02-29')),true);
 const s=setup();s.setScan(scan([number,date]));await s.controller.scan();s.controller.edit(number.fieldId,{text:'17'});s.controller.edit(date.fieldId,{text:'2024-02-30'});assert.equal(questionQueue(s.controller.snapshot()).length,2);s.controller.dispose();
});
test('an older status response cannot replace facts confirmed by a completed fill',async()=>{
 const previous=session();let delayed=false,complete;
 const s=setup({ensure:async()=>previous,status:()=>delayed?new Promise(resolve=>{complete=resolve;}):Promise.resolve(previous),fill:async(request,items)=>request.type==='PIKO_FILL_REVIEW'?{ok:true,reviewId:id('review',1),expiresAt:Date.now()+60000,preflight:{ok:true,results:items.map(i=>({fieldId:i.fieldId,status:'not-verified'}))}}:{ok:true,result:{batchId:id('batch',1),status:'completed',results:items.map(i=>({fieldId:i.fieldId,status:'filled'}))},memory:{saved:1,session:{...previous,version:2,facts:[{factId:id('fact',1),key:'full_name',value:'Alex Thomas',source:'user_confirmed',confirmedAt:Date.now()}]}}}});
 await s.controller.scan();s.controller.edit(fields[0].fieldId,{text:'Alex Thomas',selected:true});await s.controller.review();s.controller.rememberCheckbox(true);s.controller.approveCheckbox(true);delayed=true;const refresh=s.controller.refreshSession();await s.controller.fill();complete(previous);await refresh;assert.equal(s.controller.snapshot().stage,'results');assert.equal(s.controller.snapshot().session.version,2);assert.equal(s.controller.snapshot().session.facts.length,1);s.controller.dispose();
});
