const assert=require('node:assert/strict'),path=require('node:path'),{test}=require('node:test');
const load=require('./helpers/load-typescript.cjs')(),root=path.resolve(__dirname,'../apps/extension/src');
const{GuidedAssistant,confirmationIntent}=load(path.join(root,'features/assistant/guided-assistant.ts'));
const{AssistantOrchestrator}=load(path.join(root,'features/assistant/assistant.orchestrator.ts'));
const id=(p,n)=>`${p}_${String(n).padStart(32,'0')}`;
const fields=['Full name','Email address'].map((label,index)=>({fieldId:id('field',index+1),label,labelSource:'label',labelUncertain:false,fieldType:index?'email':'text',required:true,visible:true,enabled:true,readOnly:false,eligible:true,exclusionReasons:[],options:[],constraints:{}}));
function setup(override={}){
 const formFields=override.fields??fields;
 const calls={fills:[],reviews:[],spoken:[],requests:[]},now=Date.now(),session={sessionId:id('session',1),origin:'https://form.test',createdAt:now,expiresAt:now+1800000,version:1,facts:[]};
 const scan={tabId:1,inventory:{scanId:id('scan',1),documentId:id('document',1),origin:session.origin,forms:[{formId:id('form',1),label:'Form',fields:formFields}]}};
 const workflow=new AssistantOrchestrator({scan:async()=>scan,stopScan:async()=>{},status:async()=>session,ensure:async()=>session,clear:async()=>{},speak:async()=>{},stopSpeech:()=>{},resetVoice:()=>{},cancelReview:async()=>{},interpret:async request=>{calls.requests.push(request);const values=[/Alex Thomas|Maya Chen/.exec(request.transcript)?.[0],/[a-z]+@example\.test/.exec(request.transcript)?.[0]];return{scanId:request.scanId,updates:formFields.flatMap((field,i)=>request.fields.some(current=>current.fieldId===field.fieldId)&&values[i]?[{fieldId:field.fieldId,target:{kind:field.fieldType,value:values[i]},evidence:{source:'transcript',factId:null,quote:request.transcript}}]:[]),clarifications:[],missingFields:request.fields.filter(f=>f.required&&!formFields.some((field,i)=>field.fieldId===f.fieldId&&values[i])).map(f=>({fieldId:f.fieldId,question:`What is your ${f.label}?`}))};},fill:async(request,items)=>{if(request.type==='PIKO_FILL_REVIEW'){calls.reviews.push(items);return{ok:true,reviewId:id('review',calls.reviews.length),expiresAt:Date.now()+60000,preflight:{ok:true,results:items.map(item=>({fieldId:item.fieldId,status:'not-verified'}))}};}calls.fills.push(items);return{ok:true,result:{batchId:id('batch',calls.fills.length),status:'completed',results:items.map(item=>({fieldId:item.fieldId,status:'filled'}))}};},...override});
 const guide=new GuidedAssistant(workflow,{connect:async()=>({transcription:true,speech:true}),permission:async()=>{},summarize:async()=>({scanId:scan.inventory.scanId,summary:'This form asks for your name and email.'}),speak:async text=>{calls.spoken.push(text);return true;}});
 return{guide,workflow,calls};
}
test('guided multi-field form confirms only at the end of filling the form',async()=>{
 const s=setup();await s.guide.start(true);assert.equal(s.guide.snapshot().phase,'answer');assert.equal(s.calls.spoken[0],'Analysing the form.');assert.ok(s.calls.spoken.some(text=>/form asks/.test(text)));
 await s.guide.answer('Alex Thomas');
 assert.equal(s.guide.snapshot().phase,'answer');
 assert.equal(s.guide.snapshot().fieldId,fields[1].fieldId);
 assert.match(s.guide.snapshot().message,/email address/);
 assert.equal(s.calls.fills.length,0);
 assert.equal(s.calls.reviews.length,0);
 await s.guide.answer('alex@example.test');
 assert.equal(s.guide.snapshot().phase,'confirm');
 assert.equal(s.calls.fills.length,0);
 assert.equal(s.calls.reviews.length,1);
 assert.equal(s.calls.reviews[0].length,2);
 assert.match(s.guide.snapshot().message,/All answers are ready/);
 await s.guide.answer('yes');
 assert.equal(s.calls.fills.length,1);
 assert.equal(s.calls.fills[0].length,2);
 assert.equal(s.guide.snapshot().phase,'complete');
 s.guide.dispose();
});
test('no and corrections revoke the previous exact review; ambiguous yes does not fill',async()=>{
 const s=setup({fields:[fields[0]]});await s.guide.start(false);await s.guide.answer('Alex Thomas');const old=s.guide.snapshot().turn;await s.guide.answer('no');assert.equal(s.guide.snapshot().phase,'answer');assert.equal(s.workflow.snapshot().review,null);await s.guide.answer('yes',old);assert.equal(s.calls.fills.length,0);await s.guide.answer('Maya Chen');await s.guide.answer('yes but that is wrong');assert.equal(s.calls.fills.length,0);s.guide.dispose();
});
test('late spoken yes cannot approve after a typed correction or stale page',async()=>{
 const s=setup({fields:[fields[0]]});await s.guide.start(false);await s.guide.answer('Alex Thomas');const ticket=s.guide.snapshot().turn;s.guide.typing();await s.guide.answer('yes',ticket);assert.equal(s.calls.fills.length,0);s.guide.stale('changed');await s.guide.confirm();assert.equal(s.calls.fills.length,0);assert.equal(s.guide.snapshot().phase,'stale');s.guide.dispose();
});
test('manual fallback and skipping preserve unresolved required fields without inventing answers',async()=>{
 const s=setup({interpret:async()=>{throw Error('PRIVATE diagnostic');}});await s.guide.start(false);await s.guide.answer('Alex Thomas');assert.equal(s.guide.snapshot().phase,'answer');assert.ok(s.guide.snapshot().error);await s.guide.manual('Alex Thomas');assert.equal(s.guide.snapshot().phase,'answer');assert.equal(s.guide.snapshot().fieldId,fields[1].fieldId);await s.guide.skip();assert.equal(s.guide.snapshot().phase,'confirm');await s.guide.confirm();assert.equal(s.guide.snapshot().phase,'complete');assert.match(s.guide.snapshot().message,/1 required/);assert.equal(s.calls.fills.length,1);await s.guide.end();assert.equal(s.guide.snapshot().phase,'idle');s.guide.dispose();
});
test('only strict affirmative utterances count as approval',()=>{for(const text of ['yes','Yes.','Yes, that’s correct.','correct']){if(text.includes('’'))continue;assert.equal(confirmationIntent(text),'yes');}for(const text of ['yes but change it','yesterday','not yes','yes no'])assert.notEqual(confirmationIntent(text),'yes');});
test('expired review returns to collection and final review never submits or refills',async()=>{
 const s=setup({fields:[fields[0]]});await s.guide.start(false);await s.guide.answer('Alex Thomas');s.workflow.expireReview();assert.equal(s.guide.snapshot().phase,'answer');await s.guide.confirm();assert.equal(s.calls.fills.length,0);await s.guide.manual('Alex Thomas');await s.guide.confirm();await s.guide.finishReview();assert.equal(s.guide.snapshot().phase,'ready');assert.equal(s.calls.fills.length,1);s.guide.dispose();
});
test('spoken email punctuation is independently validated without guessing spelling or a domain',()=>{
 const{supportedText}=load(path.join(root,'features/interpretation/spoken-evidence.ts'));
 for(const item of require('./fixtures/spoken-email-cases.json'))assert.equal(supportedText(item.kind,item.value,item.quote),item.expected,JSON.stringify(item));
});
test('name sentence prefixes and generation instructions are never accepted as literal names',()=>{
 const{cleanLabel,invalidNameValue,isEmailField,isNameField,requestedNameValue}=load(path.join(root,'features/interpretation/name-intent.ts'));
 for(const value of ['My name is Dario George','I am Dario George','use a random name','random name'])assert.equal(invalidNameValue(value),true);
 assert.equal(isNameField('Enter Your Name:'),true);assert.equal(isNameField('Name * · Required'),true);assert.equal(isNameField('Name * (required)'),true);assert.equal(invalidNameValue('Dario George'),false);
 assert.equal(isEmailField('Email * · Required'),true);assert.equal(cleanLabel('Address * · Required'),'Address');
 assert.equal(requestedNameValue('Full name','Morgan Reed','Use a random name.','Use a random name.'),true);
 for(const [label,value,text]of[['Full name','Morgan Reed',"Don't use a random name"],['Email address','Morgan Reed','Use a random name.'],['Full name','random name','Use a random name.']])assert.equal(requestedNameValue(label,value,text,text),false);
});
test('full name is requested up front and repeating it preserves the existing confirmation',async()=>{
 const s=setup({fields:[fields[0]]});await s.guide.start(true);assert.match(s.guide.snapshot().message,/What is your full name\?/);await s.guide.answer('My name is Alex Thomas.');assert.equal(s.guide.snapshot().phase,'confirm');assert.match(s.guide.snapshot().message,/Your full name is Alex Thomas/);const review=s.workflow.snapshot().review.reviewId;
 await s.guide.answer('Alex Thomas');await s.guide.answer('My full name is Alex Thomas.');assert.equal(s.calls.requests.length,1);assert.equal(s.calls.reviews.length,1);assert.equal(s.workflow.snapshot().review.reviewId,review);assert.equal(s.calls.fills.length,0);assert.equal(s.guide.snapshot().phase,'confirm');assert.match(s.guide.snapshot().message,/Please say yes/);
 await s.guide.answer('Yes, my full name is Alex Thomas.');assert.equal(s.calls.fills.length,1);assert.equal(s.guide.snapshot().phase,'complete');s.guide.dispose();
});
test('a corrected full name is processed without asking for the name again first',async()=>{
 const s=setup({fields:[fields[0]]});await s.guide.start(true);await s.guide.answer('Alex Thomas');const before=s.calls.spoken.length;await s.guide.answer('My full name is Maya Chen.');assert.equal(s.guide.snapshot().phase,'confirm');assert.match(s.guide.snapshot().message,/Your full name is Maya Chen/);assert.equal(s.calls.spoken.slice(before).some(text=>/What is your/.test(text)),false);assert.equal(s.calls.fills.length,0);s.guide.dispose();
});
test('name confirmation matches the complete value and never accepts a negated or different name',()=>{
 const{confirmsName,sameNameAnswer,nameDescription,extractDirectAnswer}=load(path.join(root,'features/interpretation/name-intent.ts'));
 assert.equal(nameDescription('First name'),'first name');assert.equal(nameDescription('Last name'),'last name');assert.equal(nameDescription('Full name'),'full name');assert.equal(nameDescription('Name'),'name');assert.equal(nameDescription('Name * · Required'),'name');assert.equal(sameNameAnswer('My name is Dario George.','Dario George'),true);
 assert.equal(extractDirectAnswer('Texas',{label:'Address'}),'Texas');assert.equal(extractDirectAnswer('My address is Texas',{label:'Address'}),'Texas');
 for(const text of ['Yes, Dario George.','Yes, my full name is Dario George.',"Yes, that's my full name."])assert.equal(confirmsName(text,'Dario George'),true,text);
 for(const text of ['Dario George','Yes, not Dario George','Yes, Dario','Yes, Dario George but change it','No, Dario George'])assert.equal(confirmsName(text,'Dario George'),false,text);
});
test('a thank-you transcription is retried as speech, never proposed or reviewed as a name',async()=>{
 const s=setup({fields:[fields[0]]});await s.guide.start(true);await s.guide.answer('Thank you. Thank you very much.');assert.equal(s.guide.snapshot().phase,'answer');assert.match(s.guide.snapshot().message,/couldn't make out your full name/);assert.equal(s.guide.snapshot().listen,true);assert.equal(s.calls.requests.length,0);assert.equal(s.calls.reviews.length,0);assert.equal(s.calls.fills.length,0);
 await s.guide.answer('My name is Alex Thomas.');assert.equal(s.guide.snapshot().phase,'confirm');const review=s.workflow.snapshot().review.reviewId;await s.guide.answer('Thank you.');assert.equal(s.guide.snapshot().phase,'confirm');assert.equal(s.workflow.snapshot().review.reviewId,review);assert.equal(s.calls.requests.length,1);assert.equal(s.calls.fills.length,0);await s.guide.answer('yes');assert.equal(s.guide.snapshot().phase,'complete');s.guide.dispose();
});
test('native field rejection is explained aloud and a corrected answer can be reviewed',async()=>{
 let reject=true;const s=setup({fields:[fields[0]],fill:async(request,items)=>reject?{ok:false,error:'invalid',preflight:{ok:false,results:items.map(item=>({fieldId:item.fieldId,status:'invalid',reason:'constraint'}))}}:{ok:true,reviewId:id('review',9),expiresAt:Date.now()+60000,preflight:{ok:true,results:items.map(item=>({fieldId:item.fieldId,status:'not-verified'}))}}});await s.guide.start(true);await s.guide.answer('Alex Thomas');assert.match(s.guide.snapshot().error,/This page rejected the answer/);assert.equal(s.calls.spoken.at(-1),s.guide.snapshot().error);assert.equal(s.guide.snapshot().listen,true);reject=false;await s.guide.answer('My name is Maya Chen.');assert.match(s.guide.snapshot().message,/Maya Chen/);assert.equal(s.guide.snapshot().phase,'confirm');s.guide.dispose();
});
test('single-word answer for a field is populated directly without clarification',async()=>{
 const s=setup({fields:[fields[0]],interpret:async request=>({scanId:request.scanId,updates:[],clarifications:[{question:'Please provide your full address',targetFieldIds:[fields[0].fieldId]}],missingFields:[{fieldId:fields[0].fieldId,question:'What is your address?'}]})});
 await s.guide.start(false);
 await s.guide.answer('Texas');
 assert.equal(s.guide.snapshot().phase,'confirm');
 assert.match(s.guide.snapshot().message,/Texas/);
 s.guide.dispose();
});
test('spoken email is extracted cleanly, saved to draft and not asked again',async()=>{
 const{extractEmailCandidate,extractDirectAnswer}=load(path.join(root,'features/interpretation/name-intent.ts'));
 assert.equal(extractEmailCandidate('my email is dario at gmail dot com'),'dario@gmail.com');
 assert.equal(extractEmailCandidate('dario at the rate gmail dot com'),'dario@gmail.com');
 assert.equal(extractEmailCandidate('dario 06 at gmail dot com'),'dario06@gmail.com');
 assert.equal(extractDirectAnswer('my email is dario at example dot com',{label:'Email * · Required',fieldType:'text'}),'dario@example.com');
 const emailField={...fields[1],fieldType:'text',label:'Email * · Required'};
 const s=setup({fields:[emailField],interpret:async request=>({scanId:request.scanId,updates:[{fieldId:emailField.fieldId,target:{kind:'text',value:'dario@example.com'},evidence:{source:'transcript',factId:null,quote:request.transcript}}],clarifications:[],missingFields:[]})});
 await s.guide.start(true);
 assert.match(s.guide.snapshot().message,/email address/);
 await s.guide.answer('my email is dario at example dot com');
 assert.equal(s.guide.snapshot().phase,'confirm');
 assert.equal(s.workflow.snapshot().drafts[emailField.fieldId]?.text,'dario@example.com');
 assert.equal(s.calls.spoken.filter(text=>/What is your email/.test(text)).length,1);
 s.guide.dispose();
});

