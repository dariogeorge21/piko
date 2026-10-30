"""Synthetic media tests; real-model checks are opt-in and never persist audio."""

import asyncio
import io
import json
import math
import os
import sys
import tempfile
import unittest
import wave
from dataclasses import replace
from array import array
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/local-service"))
from httpx import ASGITransport, AsyncClient
from app.main import create_app
from app.services.piper_service import PiperService, PiperConfig

def no_speech():
    return PiperService(PiperConfig(voice_path=Path(__file__).parent / "fixtures/missing-voice.onnx"))

from app.transcription import Transcriber, Transcript, VoiceError, run_process
from app.voice_config import VoiceConfig, MAX_AUDIO_BYTES

ORIGIN = "chrome-extension://" + "a" * 32


def wav_bytes(seconds=1, silent=False):
    pcm = array("h", (0 if silent else int(math.sin(index * 440 * 2 * math.pi / 16000) * 4000) for index in range(round(seconds * 16000))))
    if sys.byteorder != "little":
        pcm.byteswap()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="piko-pipeline-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = VoiceConfig(Path("whisper"), Path("model"), Path("ffmpeg"), Path("ffprobe"), configured=True)
        self.calls = []
        self.duration = 1
        self.silent = False
        self.fail = None
        self.transcript = "Synthetic speech for testing."
        self.pipeline = Transcriber(self.config, self.runner, self.root)

    async def runner(self, args, timeout, error, capture=False):
        self.calls.append((args, timeout, error))
        if error == self.fail:
            raise VoiceError(error)
        if capture:
            return json.dumps({"format": {"duration": str(self.duration), "format_name": "wav"}, "streams": [{"codec_type": "audio", "codec_name": "pcm_s16le"}]}).encode()
        if error == "conversion-failed":
            Path(args[-1]).write_bytes(wav_bytes(self.duration, self.silent))
        else:
            Path(args[args.index("-of") + 1] + ".txt").write_text(self.transcript, encoding="utf-8")
        return b""

    def assert_clean(self):
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertFalse(self.pipeline.busy)

    async def test_normalizes_then_whispers_with_fixed_cpu_flags_and_cleans_every_file(self):
        result = await self.pipeline.transcribe(wav_bytes())
        self.assertEqual(result.status, "ok"); self.assertEqual(result.text, self.transcript)
        self.assertEqual(result.durationMs, 1000)
        self.assertEqual([call[2] for call in self.calls], ["invalid-audio", "conversion-failed", "transcription-failed"])
        ffmpeg = self.calls[1][0]
        self.assertEqual(ffmpeg[ffmpeg.index("-ar") + 1], "16000")
        self.assertEqual(ffmpeg[ffmpeg.index("-ac") + 1], "1")
        self.assertEqual(ffmpeg[ffmpeg.index("-c:a") + 1], "pcm_s16le")
        for flag in ("-nf", "-sns", "-ng", "-otxt", "-np", "-nt"):
            self.assertIn(flag, self.calls[2][0])
        self.assert_clean()

    async def test_silence_never_runs_whisper(self):
        self.silent = True
        result = await self.pipeline.transcribe(wav_bytes(silent=True))
        self.assertEqual(result.status, "no-speech"); self.assertEqual(result.text, "")
        self.assertEqual(len(self.calls), 2); self.assert_clean()

    async def test_configured_vad_preserves_short_spoken_answers(self):
        self.pipeline.config = replace(self.config, vad_model=Path('silero.bin'))
        await self.pipeline.transcribe(wav_bytes())
        args = self.calls[-1][0]
        self.assertIn('--vad', args)
        self.assertEqual(args[args.index('-vm') + 1], 'silero.bin')
        self.assertEqual(args[args.index('-vspd') + 1], '100')
        self.assertEqual(args[args.index('-vp') + 1], '150')
        self.assert_clean()

    async def test_empty_and_unsupported_media(self):
        for audio, code in [(b"", "empty-audio"), (b"PRIVATE not media", "unsupported-audio"), (b"x" * (MAX_AUDIO_BYTES + 1), "audio-too-large")]:
            with self.assertRaises(VoiceError) as error:
                await self.pipeline.transcribe(audio)
            self.assertEqual(error.exception.code, code)
            self.assert_clean()

    async def test_duration_rejected_before_whisper_and_never_truncated(self):
        self.duration = 21
        with self.assertRaises(VoiceError) as error:
            await self.pipeline.transcribe(wav_bytes())
        self.assertEqual(error.exception.code, "audio-too-long")
        self.assertEqual(len(self.calls), 1); self.assert_clean()

    async def test_missing_probe_duration_uses_actual_decoded_frames_and_rejects_overlong_media(self):
        async def no_duration(args, timeout, error, capture=False):
            if capture:
                return b'{"format":{"format_name":"wav"},"streams":[{"codec_type":"audio","codec_name":"pcm_s16le"}]}'
            return await self.runner(args, timeout, error, capture)
        self.duration = 21
        self.pipeline.runner = no_duration
        with self.assertRaises(VoiceError) as error:
            await self.pipeline.transcribe(wav_bytes())
        self.assertEqual(error.exception.code, "audio-too-long"); self.assert_clean()

    async def test_too_short_audio(self):
        self.duration = 0.1
        with self.assertRaises(VoiceError) as error:
            await self.pipeline.transcribe(wav_bytes())
        self.assertEqual(error.exception.code, "empty-audio"); self.assert_clean()

    async def test_probe_conversion_and_model_failures_always_clean(self):
        for failure in ("invalid-audio", "conversion-failed", "transcription-failed"):
            self.fail = failure
            with self.assertRaises(VoiceError) as error:
                await self.pipeline.transcribe(wav_bytes())
            self.assertEqual(error.exception.code, failure); self.assert_clean()

    async def test_corrupt_probe_and_invalid_transcript_rejected(self):
        self.transcript = "x" * 4097
        with self.assertRaises(VoiceError):
            await self.pipeline.transcribe(wav_bytes())
        self.assert_clean()
        self.pipeline.runner = lambda *args: asyncio.sleep(0, result=b'{"format":{}}')
        with self.assertRaises(VoiceError) as error:
            await self.pipeline.transcribe(wav_bytes())
        self.assertEqual(error.exception.code, "invalid-audio"); self.assert_clean()

    async def test_empty_whisper_result_is_no_speech(self):
        self.transcript = "[BLANK_AUDIO]"
        self.assertEqual((await self.pipeline.transcribe(wav_bytes())).status, "no-speech")
        self.assert_clean()

    async def test_cancellation_and_concurrency_release_process_files_and_slot(self):
        started = asyncio.Event()
        async def slow(args, timeout, error, capture=False):
            if error == "transcription-failed":
                started.set(); await asyncio.Event().wait()
            return await self.runner(args, timeout, error, capture)
        self.pipeline.runner = slow
        task = asyncio.create_task(self.pipeline.transcribe(wav_bytes()))
        await started.wait()
        with self.assertRaises(VoiceError) as error:
            await self.pipeline.transcribe(wav_bytes())
        self.assertEqual(error.exception.code, "transcription-busy")
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assert_clean()

    async def test_missing_configuration(self):
        with self.assertRaises(VoiceError) as error:
            await Transcriber(VoiceConfig()).transcribe(wav_bytes())
        self.assertEqual(error.exception.code, "model-unavailable")
        self.assertFalse(VoiceConfig.load({}).configured)
        self.assertFalse(VoiceConfig.load({"WHISPER_CPP_CLI": "not present"}).configured)

    async def test_real_subprocess_timeout_and_output_bound(self):
        with self.assertRaises(VoiceError) as error:
            await run_process([sys.executable, "-c", "import time; time.sleep(30)"], 0.1, "transcription-failed")
        self.assertEqual(error.exception.code, "transcription-timeout")
        with self.assertRaises(VoiceError):
            await run_process([sys.executable, "-c", "print('x' * 20000)"], 3, "invalid-audio", True)


class UploadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        class FixtureTranscriber:
            config = VoiceConfig(configured=True)
            async def transcribe(self, audio):
                if not audio:
                    raise VoiceError("empty-audio")
                return Transcript(status="ok", text="Synthetic fixture transcript", durationMs=1000, processingMs=1)
        announcements = []
        self.app = create_app(announce=announcements.append, transcriber=FixtureTranscriber(), piper_service=no_speech())
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.addAsyncCleanup(self.lifespan.__aexit__, None, None, None)
        self.client = AsyncClient(transport=ASGITransport(app=self.app), base_url="http://127.0.0.1:8765", headers={"Origin": ORIGIN})
        self.addAsyncCleanup(self.client.aclose)
        paired = await self.client.post("/v1/pair", json={"protocol_version": 1, "code": announcements[0].split(": ")[-1]})
        self.auth = {"Authorization": f'Bearer {paired.json()["token"]}'}

    async def test_authenticated_multipart_and_filename_is_not_a_path(self):
        response = await self.client.post("/v1/transcribe", files={"file": ("../../PRIVATE.wav", wav_bytes(), "text/plain")}, headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "Synthetic fixture transcript")
        self.assertNotIn("PRIVATE", response.text)

    async def test_authentication_precedes_media_parsing(self):
        response = await self.client.post("/v1/transcribe", content=b"x" * 100000)
        self.assertEqual(response.status_code, 415)
        response = await self.client.post("/v1/transcribe", files={"file": ("audio.wav", wav_bytes())}, headers={**self.auth, "Origin": "https://example.test"})
        self.assertEqual(response.status_code, 200)

    async def test_size_limits_even_without_declared_length(self):
        response = await self.client.post("/v1/transcribe", files={"file": ("audio.wav", b"x" * (MAX_AUDIO_BYTES + 1))}, headers=self.auth)
        self.assertEqual(response.status_code, 413)
        async def chunks():
            for _ in range(130):
                yield b"x" * 65536
        response = await self.client.post("/v1/transcribe", content=chunks(), headers={**self.auth, "Content-Type": "multipart/form-data; boundary=test"})
        self.assertIn(response.status_code, (413, 422))

    async def test_extra_fields_multiple_files_empty_audio_and_wrong_media_type(self):
        for arguments in [
            {"files": {"file": ("audio.wav", b"")}},
            {"files": [("file", ("a.wav", wav_bytes())), ("file", ("b.wav", wav_bytes()))]},
            {"files": {"file": ("a.wav", wav_bytes())}, "data": {"modelPath": "PRIVATE"}},
            {"json": {"command": "PRIVATE"}},
        ]:
            response = await self.client.post("/v1/transcribe", headers=self.auth, **arguments)
            self.assertIn(response.status_code, (415, 422))
            self.assertNotIn("PRIVATE", response.text)

    async def test_session_revoked_during_inference_cannot_receive_a_result(self):
        response = await self.client.post("/v1/transcribe", files={"file": ("a.wav", wav_bytes())}, headers=self.auth)
        self.assertEqual(response.status_code, 200)

    async def test_request_cancellation_cancels_its_inference_job(self):
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def blocked(_audio):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        self.app.state.transcriber.transcribe = blocked
        response = asyncio.create_task(self.client.post("/v1/transcribe", files={"file": ("a.wav", wav_bytes())}, headers=self.auth))
        await entered.wait()
        response.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await response
        self.assertTrue(cancelled.is_set())


@unittest.skipUnless(os.environ.get("PIKO_TEST_REAL_VOICE") == "1", "set PIKO_TEST_REAL_VOICE=1 to test the installed CPU model")
class RealVoiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_installed_vad_rejects_non_speech_tone(self):
        config = VoiceConfig.load()
        self.assertIsNotNone(config.vad_model)
        result = await Transcriber(config).transcribe(wav_bytes(seconds=3))
        self.assertEqual(result.status, 'no-speech')
        self.assertEqual(result.text, '')

    async def test_actual_ffmpeg_whisper_and_cleanup(self):
        config = VoiceConfig.load()
        self.assertTrue(config.configured)
        sample = Path(__file__).resolve().parents[1] / "vendor/whisper.cpp/samples/jfk.wav"
        with tempfile.TemporaryDirectory(prefix="piko-real-voice-test-") as directory:
            pipeline = Transcriber(config, temp_root=Path(directory))
            result = await pipeline.transcribe(sample.read_bytes())
            self.assertEqual(result.status, "ok")
            self.assertIn("country", result.text.lower())
            self.assertEqual(list(Path(directory).iterdir()), [])
            silent = await pipeline.transcribe(wav_bytes(silent=True))
            self.assertEqual(silent.status, "no-speech")
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
