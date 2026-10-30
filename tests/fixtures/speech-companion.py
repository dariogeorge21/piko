"""Test-only entry point: real authentication/boundaries, optional real Piper/Qwen.
Whisper is an explicit fixture here; real-microphone STT remains an opt-in suite.
"""
import asyncio
import io
import json
import os
from pathlib import Path
import struct
import sys
import types
import wave

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'apps/local-service'))
from app.main import create_app
from app.services.piper_service import SpeechError
from app.transcription import Transcript
from app.voice_config import MAX_AUDIO_BYTES
import uvicorn

class FixtureTranscriber:
    config=types.SimpleNamespace(configured=True,max_bytes=MAX_AUDIO_BYTES)
    calls=0
    async def transcribe(self,_data):
        answers=json.loads(os.environ.get('PIKO_TEST_TRANSCRIPTS','["My full name is Alex Thomas."]'))
        text=answers[min(self.calls,len(answers)-1)];self.calls+=1
        return Transcript(status='ok',text=text,language='en',durationMs=1000,processingMs=1)

class FixtureSpeech:
    ready=True
    reason=None
    async def start(self):pass
    async def close(self):pass
    async def synthesize(self,text):
        if text=='Slow synthetic question.':await asyncio.sleep(2)
        if text=='Make this fail.':raise SpeechError('speech-synthesis-failed',502)
        stream=io.BytesIO()
        with wave.open(stream,'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(22050)
            frames=2205 if os.environ.get('PIKO_TEST_FAST_SPEECH')=='1' else 22050*(6 if len(text)>70 else 1)
            audio.writeframes(struct.pack('<h',1000)*frames)
        return stream.getvalue()

if __name__=='__main__':
    app=create_app(transcriber=FixtureTranscriber(),piper_service=None if os.environ.get('PIKO_TEST_REAL_PIPER')=='1' else FixtureSpeech())
    uvicorn.run(app,host='127.0.0.1',port=8765,access_log=False,proxy_headers=False,log_level='warning')
