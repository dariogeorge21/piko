const {expect,chromium}=require('@playwright/test');
const http=require('node:http'),net=require('node:net'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const{spawn,spawnSync}=require('node:child_process'),{once}=require('node:events');
const root=path.resolve(__dirname,'../..'),python=path.join(root,'apps/local-service/.venv/bin/python');
const formHTML='<!doctype html><title>Contact form</title><form><label>Full name<input id="name" required></label><label>Email address<input id="email" type="email" required></label><input type="password" value="PRIVATE" aria-label="Password"><button>Submit</button></form><script>window.submits=0;document.addEventListener("submit",e=>{e.preventDefault();window.submits++});</script>';
async function listen(server,port=0){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});return`http://127.0.0.1:${server.address().port}`;}
function fakeWav(){const samples=48000,buffer=Buffer.alloc(44+samples*2);buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);for(let n=0;n<9600;n++)buffer.writeInt16LE(Math.round(4000*Math.sin(n/16000*440*2*Math.PI)),44+n*2);return buffer;}
class BrowserHarness{
 mode='normal';requests=[];responses=[];modelRequests=[];errors=[];
 async open(options={}){
  this.options=options;
  const running=options.realVoice&&process.env.PIKO_TEST_USE_RUNNING_SERVICE==='1';
  if(!running){const probe=net.createServer();await listen(probe,8765);await new Promise(resolve=>probe.close(resolve));}
  this.temporary=await fs.mkdtemp(path.join(os.tmpdir(),'piko-guided-browser-'));
  this.fixture=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end(formHTML);});this.base=await listen(this.fixture);
  this.model=http.createServer(async(request,response)=>{
   response.setHeader('Content-Type','application/json');let input='';for await(const chunk of request)input+=chunk;
   if(request.url==='/api/tags'){response.end(JSON.stringify({models:[{name:'qwen3.5:2b'}]}));return;}
   if(request.url==='/api/show'){response.end('{"model_info":{"general.architecture":"qwen35"}}');return;}
   const payload=JSON.parse(input),content=JSON.parse(payload.messages[1].content);this.modelRequests.push(content);
   const active=this.mode;if(active==='slow')await new Promise(resolve=>{this.release=resolve;});if(response.destroyed)return;
   let output;if(payload.format.properties.summary)output={summary:'This form asks for your full name and email address.'};
   else{const updates=[];for(const field of content.fields){let value=field.type==='email'?/[a-z]+@example\.test/.exec(content.transcript)?.[0]:/Alex Thomas|Maya Chen|Dario George/.exec(content.transcript)?.[0];if(!value&&field.label==='Full name'&&/^(?:please )?use (?:a )?random name[.!]?$/i.test(content.transcript))value='Morgan Reed';if(value)updates.push({fieldId:active==='unknown'?`field_${'f'.repeat(32)}`:field.fieldId,target:{kind:field.type,value},evidence:{source:'transcript',factId:null,quote:content.transcript}});}output={updates,clarifications:[]};}
   response.end(JSON.stringify({model:'qwen3.5:2b',done:true,message:{role:'assistant',content:JSON.stringify(output)}}));
  });const modelURL=await listen(this.model);
  const env={...process.env,PYTHONUNBUFFERED:'1',PIKO_TEST_REAL_PIPER:options.realSpeech?'1':'0',PIKO_TEST_FAST_SPEECH:'1',PIKO_TEST_TRANSCRIPTS:JSON.stringify(options.transcripts||['My full name is Alex Thomas.','Yes.','My email is alex@example.test.','Yes.']),OLLAMA_MODEL:'qwen3.5:2b',OLLAMA_BASE_URL:options.realModel?'http://127.0.0.1:11434':modelURL};
  if(!running)this.service=spawn(python,options.realVoice?['-m','app']:[path.join(root,'tests/fixtures/speech-companion.py')],{cwd:path.join(root,'apps/local-service'),env,stdio:['ignore','pipe','pipe']});
  this.service?.stderr.on('data',()=>{});this.service?.stdout.on('data',()=>{});
  await expect.poll(async()=>{try{return(await fetch('http://127.0.0.1:8765/v1/health')).status;}catch{return 0;}},{timeout:20000}).toBe(200);
  const audio=options.audio||path.join(this.temporary,'microphone.wav');this.audioPath=audio;
  if(!options.audio){if(options.realVoice){
   this.samples={name:path.join(this.temporary,'name.wav'),email:path.join(this.temporary,'email.wav'),yes:path.join(this.temporary,'yes.wav')};
   const script="import sys,wave;from piper import PiperVoice;voice=PiperVoice.load(sys.argv[1]);phrases=['My full name is Alex Thomas.','My email is alex at example dot test.','Yes.'];[(lambda audio,text:(voice.synthesize_wav(text,audio),audio.close()))(wave.open(file,'wb'),text) for file,text in zip(sys.argv[2:],phrases)]";
   const generated=spawnSync(python,['-c',script,path.join(root,'apps/local-service/voices/en_US-lessac-medium.onnx'),...Object.values(this.samples)],{env:{...process.env,ORT_DISABLE_TELEMETRY:'1'},stdio:'ignore'});expect(generated.status,'Generate the synthetic real-voice microphone fixtures').toBe(0);await fs.copyFile(this.samples.name,audio);
  }else await fs.writeFile(audio,fakeWav());}
  this.context=await chromium.launchPersistentContext(path.join(this.temporary,'profile'),{channel:'chromium',headless:true,executablePath:process.env.PIKO_CHROMIUM_PATH||undefined,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${audio}%noloop`]});
  const cdp=await this.context.browser().newBrowserCDPSession();await cdp.send('Extensions.loadUnpacked',{path:path.join(root,'apps/extension/dist')});this.worker=this.context.serviceWorkers()[0]||await this.context.waitForEvent('serviceworker');
  this.context.on('response',response=>{if(response.url().startsWith('http://127.0.0.1:8765/v1/'))this.responses.push({url:response.url(),status:response.status()});});
  this.context.on('request',request=>{if(/^https?:/.test(request.url()))this.requests.push({url:request.url(),worker:!!request.serviceWorker()});});
  this.page=await this.context.newPage();await this.page.goto(this.base);
  this.panel=await this.context.newPage();await this.panel.setViewportSize({width:360,height:800});this.panel.on('pageerror',error=>this.errors.push(error.message));
  await this.panel.addInitScript(()=>{
   window.__overlaps=0;window.__streams=[];window.__clips=[];window.__urls=[];window.__revoked=[];window.__forbidden=[];window.__blockAudio=false;
   const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await capture(constraints);if(window.__clips.some(clip=>!clip.paused))window.__overlaps++;window.__streams.push(stream);return stream;};
   const NativeAudio=Audio;window.Audio=function(url){const audio=new NativeAudio(url);window.__clips.push(audio);const play=audio.play.bind(audio);audio.play=()=>{if(window.__streams.some(stream=>stream.getTracks().some(track=>track.readyState==='live')))window.__overlaps++;return window.__blockAudio?Promise.reject(new DOMException('Blocked','NotAllowedError')):play();};return audio;};
   const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);window.__urls.push(url);return url;};URL.revokeObjectURL=url=>{window.__revoked.push(url);revoke(url);};
   for(const[object,name]of[[window,'fetch'],[XMLHttpRequest.prototype,'open'],[Storage.prototype,'setItem'],[indexedDB,'open']])object[name]=()=>{window.__forbidden.push(name);throw Error('Forbidden panel HTTP or persistence');};
  });
  await this.panel.goto(`chrome-extension://${new URL(this.worker.url()).hostname}/src/sidepanel/index.html`);await this.grant();return this;
 }
 async grant(){await this.page.bringToFront();const cdp=await this.context.browser().newBrowserCDPSession(),{targetInfos}=await cdp.send('Target.getTargets',{filter:[{}]});const target=targetInfos.find(t=>t.type==='tab'&&t.url===this.page.url());await cdp.send('Extensions.triggerAction',{id:new URL(this.worker.url()).hostname,targetId:target.targetId});}
 async start(voice=false){await this.page.bringToFront();await this.panel.getByRole('button',{name:voice?'Start voice assistant':'Use text instead',exact:true}).evaluate(button=>button.click());await expect.poll(async()=>{const alerts=await this.panel.getByRole('alert').allTextContents();if(alerts.length)return 'error: '+alerts.join(' ');return await this.panel.getByRole('status').filter({hasText:'What is your full name?'}).isVisible()?'ready':'waiting';},{timeout:this.options.realModel?75000:10000}).not.toBe('waiting');await expect(this.panel.getByRole('status').filter({hasText:'What is your full name?'})).toBeVisible();}
 async answer(text){await this.panel.getByRole('textbox').fill(text);await this.page.bringToFront();await this.panel.getByRole('button',{name:'Send answer',exact:true}).evaluate(button=>button.click());}
 async confirm(){await this.page.bringToFront();await this.panel.getByRole('button',{name:'Yes, fill it',exact:true}).evaluate(button=>button.click());}
 async send(type,extra={}){return this.panel.evaluate(message=>chrome.runtime.sendMessage(message),{type,requestId:`request_${require('node:crypto').randomUUID().replace(/-/g,'')}`,...extra});}
 async close(){
  this.release?.();
  try{
   if(this.panel&&!this.panel.isClosed()){
    const end=this.panel.getByRole('button',{name:'End session',exact:true});if(await end.isVisible()){await expect(end).toBeEnabled({timeout:10000});await end.evaluate(button=>button.click());}
    await expect.poll(()=>this.panel.evaluate(()=>window.__streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')))).toBe(true);
    expect(await this.panel.evaluate(()=>window.__forbidden)).toEqual([]);expect(await this.panel.evaluate(()=>window.__overlaps)).toBe(0);expect(await this.panel.evaluate(()=>window.__clips.every(clip=>clip.paused))).toBe(true);expect(await this.panel.evaluate(()=>window.__urls.slice().sort())).toEqual(await this.panel.evaluate(()=>window.__revoked.slice().sort()));
   }
   if(this.page&&!this.page.isClosed())expect(await this.page.evaluate(()=>window.submits)).toBe(0);
   expect(this.errors).toEqual([]);
   if(this.worker)expect(await this.worker.evaluate(async()=>Object.keys(await chrome.storage.local.get(null)))).toEqual([]);
   expect(this.requests.every(r=>r.worker&&r.url.startsWith('http://127.0.0.1:8765/v1/')||r.url===this.base+'/')).toBe(true);
  }finally{
   await this.context?.close();
   if(this.service&&this.service.exitCode===null){const done=once(this.service,'exit');this.service.kill();await done;}
   for(const server of[this.model,this.fixture])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
   if(this.temporary){if(path.dirname(this.temporary)!==os.tmpdir()||!path.basename(this.temporary).startsWith('piko-guided-browser-'))throw Error('Unexpected cleanup');await fs.rm(this.temporary,{recursive:true,force:true});}
  }
 }
}
module.exports={BrowserHarness,fakeWav};
