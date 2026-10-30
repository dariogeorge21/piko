const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const createLoader = require('./helpers/load-typescript.cjs');
const root = path.resolve(__dirname, '../apps/extension/src');
const load = createLoader();
const { RecordingController } = load(path.join(root, 'features/voice-input/recording.controller.ts'));
const { AudioTransfer } = load(path.join(root, 'background/audio-transfer.ts'));
const { isAudioMessage, isTranscript } = load(path.join(root, 'features/voice-input/transcription.validation.ts'));
const { AUDIO_CHUNK_BYTES, MAX_AUDIO_BYTES } = load(path.join(root, 'features/voice-input/transcription.types.ts'));
const recordingId = `rec_${'0'.repeat(32)}`;
const result = { status: 'ok', text: 'Synthetic transcript.', language: 'en', durationMs: 1000, processingMs: 1 };
const flush = () => new Promise(setImmediate);
function recorderSetup(overrides = {}) {
  let now = 1000, captures = 0, stopped = 0;
  const track = { stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const fake = { state: 'inactive', mimeType: 'audio/webm', ondataavailable: null, onstop: null, onerror: null,
    start() { this.state = 'recording'; },
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['synthetic recording']) }); this.onstop?.(); }); },
  };
  const states = [], uploads = [];
  const controller = new RecordingController(state => states.push(state), async (...args) => { uploads.push(args); return result; }, {
    getUserMedia: async constraints => { captures++; assert.equal(constraints.video, false); return stream; },
    createRecorder: () => fake, supports: type => type === 'audio/webm', now: () => now, ...overrides,
  });
  return { controller, fake, states, uploads, stream, advance: value => { now += value; }, captures: () => captures, stopped: () => stopped };
}
test('microphone starts only explicitly and Stop ends every track before uploading a completed recording', async () => {
  const s = recorderSetup(); assert.equal(s.captures(), 0);
  await s.controller.start(); assert.equal(s.captures(), 1); assert.equal(s.controller.snapshot.stage, 'recording');
  s.advance(1000); s.controller.stop(); assert.equal(s.stopped(), 1); assert.equal(s.uploads.length, 0);
  await flush(); assert.equal(s.uploads.length, 1); assert.equal(s.controller.snapshot.stage, 'transcript-ready'); assert.equal(s.controller.retainedBytes, 0);
  s.controller.reset(); assert.equal(s.controller.snapshot.transcript, '');
});
test('automatic duration stop releases microphone without requiring Stop', async () => {
  const s = recorderSetup({ limitMs: 20 }); await s.controller.start(); s.advance(1000);
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(s.stopped(), 1); assert.notEqual(s.controller.snapshot.stage, 'recording'); s.controller.reset();
});
test('late permission grant after cancellation is stopped without recording', async () => {
  let grant; const s = recorderSetup({ getUserMedia: () => new Promise(resolve => { grant = resolve; }) });
  const starting = s.controller.start(); s.controller.reset(); grant(s.stream); await starting;
  assert.equal(s.stopped(), 1); assert.equal(s.fake.state, 'inactive'); assert.equal(s.controller.snapshot.stage, 'idle');
});
test('permission and missing-device errors are sanitized', async () => {
  for (const [name, expected] of [['NotAllowedError', 'microphone-denied'], ['NotFoundError', 'microphone-missing'], ['NotReadableError', 'recording-failed']]) {
    const s = recorderSetup({ getUserMedia: async () => { throw Object.assign(Error('PRIVATE hardware details'), { name }); } });
    await s.controller.start(); assert.equal(s.controller.snapshot.error, expected); assert.equal(JSON.stringify(s.states).includes('PRIVATE'), false);
  }
});
test('oversized or too-short recordings are discarded before upload', async () => {
  const s = recorderSetup(); await s.controller.start(); s.advance(100); s.controller.stop(); await flush();
  assert.equal(s.controller.snapshot.error, 'empty-audio'); assert.equal(s.uploads.length, 0);
  const large = recorderSetup(); await large.controller.start(); large.fake.ondataavailable({ data: new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)]) });
  assert.equal(large.controller.snapshot.error, 'audio-too-large'); assert.equal(large.controller.retainedBytes, 0); assert.equal(large.stopped(), 1);
});
test('processing cancellation aborts transport and ignores late results', async () => {
  let complete, signal, now = 1000;
  const s = recorderSetup();
  const controller = new RecordingController(() => {}, (_audio, _duration, abort) => { signal = abort; return new Promise(resolve => { complete = resolve; }); }, { getUserMedia: async () => s.stream, createRecorder: () => s.fake, supports: () => true, now: () => now });
  await controller.start(); s.fake.ondataavailable({ data: new Blob(['recording']) });
  s.fake.stop = function () { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); };
  now = 2000;
  controller.stop(); await flush(); controller.reset(); assert.equal(signal.aborted, true); complete(result); await flush();
  assert.equal(controller.snapshot.stage, 'idle'); assert.equal(controller.retainedBytes, 0);
});

test('browser default format is used when no preferred MIME type is advertised; recorder failure still releases tracks', async () => {
  let chosen = 'not-called';
  const s = recorderSetup({ supports: () => false, createRecorder: (_stream, mime) => { chosen = mime; throw Error('private device failure'); } });
  await s.controller.start(); assert.equal(chosen, undefined); assert.equal(s.stopped(), 1); assert.equal(s.controller.snapshot.error, 'recording-failed');
  const throwing = recorderSetup(); await throwing.controller.start(); throwing.fake.stop = () => { throw Error('device gone'); };
  throwing.controller.reset(); assert.equal(throwing.stopped(), 1); assert.equal(throwing.controller.snapshot.stage, 'idle');
});
function transferSetup(size = 4) {
  const replies = [], uploads = []; let released = 0;
  const transfer = new AudioTransfer(reply => replies.push(reply), async (audio, signal) => { uploads.push({ audio, signal }); return result; }, () => released++);
  const begin = { type: 'begin', recordingId, mimeType: 'audio/webm', byteLength: size, durationMs: 1000, chunkCount: Math.ceil(size / AUDIO_CHUNK_BYTES) };
  return { transfer, begin, replies, uploads, released: () => released };
}
test('strict transfer schema rejects raw blobs, arbitrary URLs, invalid duration, oversized claims and malformed base64', () => {
  const { begin, transfer } = transferSetup(); transfer.dispose(); assert.equal(isAudioMessage(begin), true);
  for (const change of [{ byteLength: MAX_AUDIO_BYTES + 1 }, { chunkCount: 999 }, { durationMs: 20001 }, { durationMs: '1000' }, { mimeType: 'text/html' }, { url: 'https://example.test' }, { blob: new Blob(['x']) }]) assert.equal(isAudioMessage({ ...begin, ...change }), false);
  assert.equal(isAudioMessage({ type: 'chunk', recordingId, index: 0, data: '!!!=' }), false);
  assert.equal(isTranscript({ ...result, selector: 'input' }), false);
  assert.equal(isTranscript({ ...result, status: 'no-speech' }), false);
});
test('complete transfer reconstructs exact bytes once and releases all buffers', async () => {
  const s = transferSetup(); await s.transfer.receive(s.begin);
  await s.transfer.receive({ type: 'chunk', recordingId, index: 0, data: Buffer.from('test').toString('base64') });
  assert.equal(s.transfer.retainedBytes, 4); await s.transfer.receive({ type: 'commit', recordingId });
  assert.equal(s.uploads.length, 1); assert.equal(await s.uploads[0].audio.text(), 'test'); assert.equal(s.replies.at(-1).type, 'result'); assert.equal(s.transfer.retainedBytes, 0); assert.equal(s.released(), 1);
  await s.transfer.receive({ type: 'commit', recordingId }); assert.equal(s.uploads.length, 1);
});
test('incomplete, replayed, out-of-order and mismatched-ID transfers never upload', async () => {
  for (const bad of [{ type: 'commit', recordingId }, { type: 'chunk', recordingId, index: 1, data: 'dGVzdA==' }, { type: 'chunk', recordingId: `rec_${'1'.repeat(32)}`, index: 0, data: 'dGVzdA==' }, { type: 'chunk', recordingId, index: 0, data: 'eA==' }]) {
    const s = transferSetup(); await s.transfer.receive(s.begin); await s.transfer.receive(bad); assert.equal(s.uploads.length, 0); assert.equal(s.replies.at(-1).type, 'error'); assert.equal(s.transfer.retainedBytes, 0); assert.equal(s.released(), 1);
  }
  const s = transferSetup(8); await s.transfer.receive(s.begin); await s.transfer.receive({ type: 'chunk', recordingId, index: 0, data: 'dGVzdHRlc3Q=' }); await s.transfer.receive({ type: 'chunk', recordingId, index: 0, data: 'dGVzdHRlc3Q=' });
  assert.equal(s.released(), 1); assert.equal(s.uploads.length, 0);
});
test('disconnection and assembly timeout release memory and abort processing', async () => {
  const s = transferSetup(); await s.transfer.receive(s.begin); s.transfer.dispose(); assert.equal(s.released(), 1);
  const replies = []; let released = false;
  new AudioTransfer(reply => replies.push(reply), async () => assert.fail('Unexpected upload'), () => { released = true; }, 5);
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(released, true); assert.equal(replies[0].error, 'invalid-transfer');
});
test('actual client uses bounded JSON/Base64 chunks and waits for every acknowledgement', async () => {
  const messages = []; let listener;
  const port = { onMessage: { addListener: fn => { listener = fn; }, removeListener() {} }, onDisconnect: { addListener() {}, removeListener() {} }, disconnect() {}, postMessage(message) {
    const wire = JSON.parse(JSON.stringify(message)); messages.push(wire);
    queueMicrotask(() => listener(wire.type === 'commit' ? { type: 'result', recordingId: wire.recordingId, result } : { type: 'ack', recordingId: wire.recordingId, nextIndex: wire.type === 'begin' ? 0 : wire.index + 1 }));
  } };
  const client = createLoader({ chrome: { runtime: { connect: () => port } } })(path.join(root, 'features/voice-input/audio-transport.ts'));
  const response = await client.uploadRecording(new Blob([new Uint8Array(AUDIO_CHUNK_BYTES + 1)], { type: 'audio/webm' }), 1000, new AbortController().signal);
  assert.deepEqual(response, result); assert.deepEqual(messages.map(message => message.type), ['begin', 'chunk', 'chunk', 'commit']);
  assert.ok(messages.filter(message => message.type === 'chunk').every(message => message.data.length <= 65536));
});
test('quiet speech and natural pauses are retained before automatic stop',()=>{
 let now=0,rms=0,stopped=0,tick,closed=0,disconnected=0;
 class AudioContextFixture{createMediaStreamSource(){return{connect(){},disconnect(){disconnected++;}};}createAnalyser(){return{fftSize:0,getFloatTimeDomainData(samples){samples.fill(rms);},disconnect(){disconnected++;}};}async resume(){}async close(){closed++;}}
 const loadSilence=createLoader({AudioContext:AudioContextFixture,performance:{now:()=>now},setInterval:callback=>{tick=callback;return 1;},clearInterval:()=>{tick=null;}}),{watchSilence}=loadSilence(path.join(root,'features/voice-input/silence-detector.ts'));
 const cleanup=watchSilence({},()=>stopped++);tick();now=500;rms=0.008;tick();rms=0;now=2600;tick();assert.equal(stopped,0);now=3101;tick();assert.equal(stopped,1);cleanup();assert.equal(closed,1);assert.equal(disconnected,2);assert.equal(tick,null);
});
