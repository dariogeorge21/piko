"""Piper contract, reusable runtime, hard bounds, authentication and offline tests."""
import asyncio
import io
import json
import logging
import os
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch
import wave
import httpx
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/local-service'))
from app.main import create_app
from app.schemas.synthesize import SynthesizeRequest, MAX_WAV_BYTES
from app.services.piper_service import PiperService, PiperConfig, SpeechError, validate_wav, SERVICE_DIR
from app.services.piper_worker import generate, main as worker_main

ORIGIN='chrome-extension://'+'a'*32


def audio_bytes(frames=2205):
    data=io.BytesIO()
    with wave.open(data,'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(22050); audio.writeframes(b'\x00\x01'*frames)
    return data.getvalue()


class FakeVoice:
    calls=[]
    def synthesize_wav(self,text,output):
        self.calls.append(text)
        output.setnchannels(1); output.setsampwidth(2); output.setframerate(22050); output.writeframes(b'\x00\x01'*2205)


class SchemaTests(unittest.TestCase):
    def test_plain_text_and_no_engine_directives(self):
        for text in ['What is your full name?', 'Your answers are ready for review.', 'Please try again.']:
            self.assertEqual(SynthesizeRequest(text=text).text,text)
        for text in ['', '   ', 'x'*801, 'Hi\nthere', 'Hi\x00', 'Hi\u202e', '<speak>Hello</speak>', '[[h ə l oʊ]]', '［［h ə l oʊ］］', '{voice:other}', '\ud800']:
            with self.subTest(text=repr(text)):
                with self.assertRaises(ValidationError): SynthesizeRequest(text=text)
        for extra in [{'voice':'remote'}, {'path':'/tmp/voice'}, {'model':'other'}, {'command':'run'}]:
            with self.assertRaises(ValidationError): SynthesizeRequest.model_validate({'text':'Hello',**extra})

    def test_config_paths_are_relative_to_service_and_bounded(self):
        config=PiperConfig.load({'PIPER_VOICE_PATH':'voices/test.onnx'})
        self.assertEqual(config.voice_path,SERVICE_DIR/'voices/test.onnx')
        for values in [{'PIPER_TIMEOUT_SECONDS':'nan'}, {'PIPER_TIMEOUT_SECONDS':'31'}, {'PIPER_MAX_TEXT_CHARS':'801'}, {'PIPER_MAX_CONCURRENCY':'2'}]:
            self.assertFalse(PiperConfig.load(values).configured)

    def test_wav_header_frames_and_output_bounds(self):
        valid=audio_bytes();validate_wav(valid)
        for data in [b'not wav',valid[:-2],valid+b'PRIVATE',b'RIFF'+b'\x00'*80]:
            with self.assertRaises(SpeechError):validate_wav(data)
        with self.assertRaises(SpeechError):validate_wav(valid,44)
        with self.assertRaises(OverflowError):generate(FakeVoice(),'Hello',100)

    def test_worker_loads_python_voice_once_for_two_phrases_and_does_not_log_text(self):
        with tempfile.TemporaryDirectory(prefix='piko-piper-worker-') as directory:
            model=Path(directory)/'voice.onnx';model.write_bytes(b'fixture')
            Path(str(model)+'.json').write_text(json.dumps({'phoneme_type':'espeak','espeak':{'voice':'en-us'}}))
            voice=FakeVoice();loaded=[]
            def load(*args,**kwargs): loaded.append(args);return voice
            messages=[text.encode() for text in ['First synthetic question.','Second synthetic status.']]
            stdin=types.SimpleNamespace(buffer=io.BytesIO(b''.join(struct.pack('>I',len(data))+data for data in messages)))
            stdout=types.SimpleNamespace(buffer=io.BytesIO())
            with patch.dict(sys.modules,{'piper':types.SimpleNamespace(PiperVoice=types.SimpleNamespace(load=load))}),patch.object(sys,'argv',['worker',str(model),str(MAX_WAV_BYTES)]),patch.object(sys,'stdin',stdin),patch.object(sys,'stdout',stdout),patch('logging.disable'),patch('logging.Logger._log') as log:
                worker_main()
            self.assertEqual(len(loaded),1)
            stream=io.BytesIO(stdout.buffer.getvalue());frames=[]
            while header:=stream.read(4):frames.append(stream.read(struct.unpack('>I',header)[0]))
            self.assertEqual(frames[0],b'R');self.assertEqual(len(frames),3)
            validate_wav(frames[1][1:]);validate_wav(frames[2][1:])
            self.assertNotIn('synthetic',str(log.call_args_list))


class FakeProcess:
    def __init__(self,frames):
        self.stdout=asyncio.StreamReader();self.stdout.feed_data(b''.join(struct.pack('>I',len(frame))+frame for frame in frames))
        self.returncode=None;self.writes=[];self.pid=1;self.stdin=self;self.terminated=False
    def write(self,data):self.writes.append(data)
    async def drain(self):pass
    def close(self):pass
    def terminate(self):self.returncode=-15;self.terminated=True;self.stdout.feed_eof()
    def kill(self):self.returncode=-9;self.terminated=True;self.stdout.feed_eof()
    async def wait(self):return self.returncode


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def config(self,**kwargs):
        directory=tempfile.TemporaryDirectory(prefix='piko-piper-runtime-');self.addCleanup(directory.cleanup)
        model=Path(directory.name)/'voice.onnx';model.write_bytes(b'fixture');Path(str(model)+'.json').write_text('{}')
        return PiperConfig(voice_path=model,**kwargs)

    async def test_missing_or_invalid_models_are_truthfully_unavailable(self):
        for config in [PiperConfig(voice_path=Path('/no-such-voice.onnx')),PiperConfig(configured=False)]:
            service=PiperService(config);await service.start();self.assertFalse(service.ready)
            with self.assertRaises(SpeechError):await service.synthesize('Hello')
            await service.close()
        process=FakeProcess([b'Espeech-voice-invalid'])
        with patch('asyncio.create_subprocess_exec',AsyncMock(return_value=process)):
            service=PiperService(self.config());await service.start();self.assertFalse(service.ready);self.assertTrue(process.terminated)

    async def test_cancelled_startup_releases_the_loading_worker(self):
        process=FakeProcess([])
        with patch('asyncio.create_subprocess_exec',AsyncMock(return_value=process)):
            service=PiperService(self.config())
            starting=asyncio.create_task(service.start())
            await asyncio.sleep(0)
            starting.cancel();await asyncio.gather(starting,return_exceptions=True)
            self.assertTrue(process.terminated);self.assertFalse(service.ready)

    async def test_one_worker_reused_and_output_remains_memory_only(self):
        process=FakeProcess([b'R',b'O'+audio_bytes(),b'O'+audio_bytes()])
        spawn=AsyncMock(return_value=process)
        with patch('asyncio.create_subprocess_exec',spawn):
            service=PiperService(self.config());await service.start();await service.start()
            self.assertTrue(service.ready)
            for _ in range(2):validate_wav(await service.synthesize('Synthetic question.'));await asyncio.sleep(0)
            self.assertEqual(spawn.await_count,1);self.assertEqual(len(process.writes),2)
            self.assertIn('app.services.piper_worker',spawn.call_args.args)
            self.assertNotIn('shell',spawn.call_args.kwargs)
            self.assertEqual(spawn.call_args.kwargs['env']['ORT_DISABLE_TELEMETRY'], '1')
            await service.close();self.assertTrue(process.terminated)

    async def test_busy_has_no_queue_cancelled_delivery_drains_and_discards(self):
        process=FakeProcess([b'R'])
        with patch('asyncio.create_subprocess_exec',AsyncMock(return_value=process)):
            service=PiperService(self.config());await service.start()
            first=asyncio.create_task(service.synthesize('First question.'));await asyncio.sleep(0);await asyncio.sleep(0)
            with self.assertRaises(SpeechError) as error:await service.synthesize('Second question.')
            self.assertEqual(error.exception.code,'speech-busy')
            first.cancel();await asyncio.gather(first,return_exceptions=True)
            self.assertIsNotNone(service.job)
            frame=b'O'+audio_bytes();process.stdout.feed_data(struct.pack('>I',len(frame))+frame)
            for _ in range(5):await asyncio.sleep(0)
            self.assertIsNone(service.job);self.assertTrue(service.ready)
            await service.close()

    async def test_timeout_terminates_native_worker_and_does_not_implicitly_reload(self):
        process=FakeProcess([b'R'])
        with patch('asyncio.create_subprocess_exec',AsyncMock(return_value=process)) as spawn:
            service=PiperService(self.config(timeout=.02));await service.start()
            with self.assertRaises(SpeechError) as error:await service.synthesize('Question.')
            self.assertEqual(error.exception.code,'speech-timeout');self.assertFalse(service.ready);self.assertTrue(process.terminated)
            with self.assertRaises(SpeechError):await service.synthesize('Retry.')
            self.assertEqual(spawn.await_count,1)
            await service.close()

    async def test_oversized_and_invalid_audio_have_safe_errors(self):
        for frame,expected in [(b'Espeech-audio-too-large','speech-audio-too-large'),(b'Espeech-synthesis-failed','speech-synthesis-failed'),(b'OPRIVATE invalid audio','invalid-speech-audio')]:
            process=FakeProcess([b'R',frame])
            with patch('asyncio.create_subprocess_exec',AsyncMock(return_value=process)):
                service=PiperService(self.config());await service.start()
                with self.assertRaises(SpeechError) as error:await service.synthesize('PRIVATE question.')
                self.assertEqual(error.exception.code,expected);self.assertNotIn('PRIVATE',str(error.exception))
                await service.close()


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.speech=types.SimpleNamespace(ready=True,reason=None,start=AsyncMock(),close=AsyncMock(),synthesize=AsyncMock(return_value=audio_bytes()))
        self.app=create_app(announce=lambda _line:None,piper_service=self.speech)
        self.lifespan=self.app.router.lifespan_context(self.app);await self.lifespan.__aenter__()
        token,_=self.app.state.pairing.pair(self.app.state.pairing.start(),ORIGIN)
        self.headers={'Authorization':'Bearer '+token}
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app,client=('127.0.0.1',1)),base_url='http://127.0.0.1:8765',headers={'Origin':ORIGIN})
    async def asyncTearDown(self):
        await self.client.aclose();await self.lifespan.__aexit__(None,None,None)
    async def test_requires_auth_before_reading_body_and_returns_valid_wav_no_store(self):
        response=await self.client.post('/v1/synthesize',content='PRIVATE')
        self.assertEqual(response.status_code,415);self.speech.synthesize.assert_not_awaited()
        response=await self.client.post('/v1/synthesize',json={'text':'What is your full name?'},headers=self.headers)
        self.assertEqual(response.status_code,200);self.assertEqual(response.headers['content-type'],'audio/wav');self.assertEqual(response.headers['cache-control'],'no-store');validate_wav(response.content)
        self.speech.start.assert_awaited_once()
    async def test_validation_errors_never_echo_speech_or_paths(self):
        for data in [{'text':''},{'text':'x'*801},{'text':'[[PRIVATE]]'},{'text':'PRIVATE','voice_path':'/PRIVATE'}]:
            response=await self.client.post('/v1/synthesize',json=data,headers=self.headers)
            self.assertEqual(response.status_code,422);self.assertNotIn('PRIVATE',response.text)
        response=await self.client.post('/v1/synthesize',content='x'*8193,headers={**self.headers,'Content-Type':'application/json'})
        self.assertEqual(response.status_code,413)
        response=await self.client.post('/v1/synthesize',content='{"text":"x","text":"PRIVATE"}',headers={**self.headers,'Content-Type':'application/json'})
        self.assertEqual(response.json(),{'error':'invalid_request'})
        self.speech.synthesize.assert_not_awaited()
    async def test_failure_and_revocation_are_normalized(self):
        self.speech.synthesize.side_effect=SpeechError('speech-timeout',504)
        response=await self.client.post('/v1/synthesize',json={'text':'PRIVATE message.'},headers=self.headers)
        self.assertEqual(response.status_code,504);self.assertEqual(response.json(),{'error':'speech-timeout'})
    async def test_capabilities_follow_loaded_voice_without_changing_health(self):
        self.app.state.ollama.available=AsyncMock(return_value=False)
        for ready,reason in [(True,None),(False,'speech-voice-missing')]:
            self.speech.ready,self.speech.reason=ready,reason
            response=await self.client.get('/v1/capabilities',headers=self.headers)
            self.assertEqual(response.json()['speech_synthesis'],'ready' if ready else 'unavailable')
            self.assertEqual(response.json()['speech_synthesis_detail'],reason)
            self.assertEqual((await self.client.get('/v1/health')).json()['status'],'ok')


@unittest.skipUnless(os.environ.get('PIKO_TEST_REAL_PIPER')=='1','Opt in to installed local Piper voice')
class RealPiperTests(unittest.IsolatedAsyncioTestCase):
    async def test_installed_voice_reused_with_no_network_or_persistent_audio(self):
        service=PiperService();await service.start();self.assertTrue(service.ready,service.reason)
        try:
            pid=service.process.pid
            for text in ['What is your full name?','Your answers are ready for review.']:
                validate_wav(await service.synthesize(text));self.assertEqual(service.process.pid,pid)
        finally:await service.close()
        # Run the Python API with network calls forbidden after voice setup.
        from piper import PiperVoice
        with patch('socket.socket.connect',side_effect=AssertionError('External network')),patch('socket.create_connection',side_effect=AssertionError('External network')):
            voice=PiperVoice.load(PiperConfig.load().voice_path)
            validate_wav(generate(voice,'What is your full name?'))

if __name__=='__main__':unittest.main()
