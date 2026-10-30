"""Bounded local media decoding and CPU Whisper execution, with no shell/logs."""

import asyncio
import json
import math
import os
import sys
import subprocess
import tempfile
import time
import wave
from array import array
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .voice_config import VoiceConfig


class VoiceError(Exception):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)


class Transcript(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    status: Literal["ok", "no-speech"]
    text: str = Field(max_length=4096)
    language: Literal["en"] = "en"
    durationMs: int = Field(ge=0, le=20000)
    processingMs: int = Field(ge=0)


def container_kind(data: bytes) -> str:
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "wav"
    if data.startswith(b"\x1aE\xdf\xa3"):
        return "webm"
    if data.startswith(b"OggS"):
        return "ogg"
    if data[4:8] == b"ftyp":
        return "mp4"
    raise VoiceError("unsupported-audio", 415)


async def run_process(args: list[str], timeout: float, error: str, capture: bool = False) -> bytes:
    creation = asyncio.create_task(asyncio.create_subprocess_exec(
        *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}),
    ))
    process = None
    try:
        try:
            process = await asyncio.shield(creation)
        except asyncio.CancelledError:
            process = await creation
            raise
        async def finish():
            result = bytearray()
            if capture:
                while chunk := await process.stdout.read(4096):
                    result.extend(chunk)
                    if len(result) > 16384:
                        raise VoiceError(error)
            await process.wait()
            if process.returncode != 0:
                raise VoiceError(error)
            return bytes(result)
        return await asyncio.wait_for(finish(), timeout)
    except asyncio.TimeoutError:
        raise VoiceError("transcription-timeout" if error == "transcription-failed" else error, 504) from None
    except OSError:
        raise VoiceError("model-unavailable", 503) from None
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()


DEFAULT_PROMPT = "A person answers a form question in English with their own accent. Short answers, personal names, email addresses, numbers, dates, yes or no."


class Transcriber:
    def __init__(self, config: VoiceConfig, runner=run_process, temp_root: Path | None = None):
        self.config, self.runner, self.temp_root = config, runner, temp_root
        self.busy = False

    async def transcribe(self, audio: bytes) -> Transcript:
        config = self.config
        if not config.configured:
            raise VoiceError("model-unavailable", 503)
        if self.busy:
            raise VoiceError("transcription-busy", 429)
        if not audio:
            raise VoiceError("empty-audio")
        if len(audio) > config.max_bytes:
            raise VoiceError("audio-too-large", 413)
        kind = container_kind(audio)
        self.busy = True
        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix="piko-voice-", dir=self.temp_root) as directory:
                root = Path(directory)
                source, normalized, output = root / "input.bin", root / "normalized.wav", root / "transcript"
                source.write_bytes(audio)
                media_options = ["-protocol_whitelist", "file,pipe"] + (["-enable_drefs", "0"] if kind == "mp4" else [])
                raw = await self.runner([str(config.ffprobe), "-v", "error", *media_options, "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels,duration", "-of", "json", str(source)], 5, "invalid-audio", True)
                try:
                    probe = json.loads(raw)
                    streams = probe["streams"]
                    formats = set(probe["format"]["format_name"].split(","))
                    expected = {"wav": {"wav"}, "webm": {"webm", "matroska"}, "ogg": {"ogg"}, "mp4": {"mov", "mp4", "m4a"}}[kind]
                    if not formats.intersection(expected) or len(streams) != 1 or streams[0]["codec_type"] != "audio" or streams[0]["codec_name"] not in {"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "opus", "vorbis", "aac", "alac"}:
                        raise ValueError()
                    duration = float(probe["format"].get("duration", streams[0].get("duration", "nan")))
                    # WebM MediaRecorder may omit duration. Decode bounded output
                    # below and check its actual frame count independently.
                    if math.isfinite(duration) and duration > config.max_seconds:
                        raise VoiceError("audio-too-long", 413)
                    if math.isfinite(duration) and duration < 0.25:
                        raise VoiceError("empty-audio")
                except (ValueError, KeyError, TypeError, IndexError):
                    raise VoiceError("invalid-audio") from None
                max_output = (config.max_seconds + 1) * 32000 + 4096
                await self.runner([str(config.ffmpeg), "-nostdin", "-hide_banner", "-loglevel", "error", *media_options, "-i", str(source), "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-fs", str(max_output), str(normalized)], 10, "conversion-failed")
                try:
                    with wave.open(str(normalized), "rb") as wav:
                        if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2 or wav.getcomptype() != "NONE":
                            raise ValueError()
                        frames = wav.getnframes()
                        if frames > config.max_seconds * 16000:
                            raise VoiceError("audio-too-long", 413)
                        if frames < 4000:
                            raise VoiceError("empty-audio")
                        pcm = wav.readframes(frames)
                        if len(pcm) != frames * 2:
                            raise ValueError()
                except (wave.Error, OSError, ValueError, EOFError):
                    raise VoiceError("invalid-audio") from None
                samples = array("h", pcm)
                if sys.byteorder != "little":
                    samples.byteswap()
                rms = math.sqrt(sum(value * value for value in samples) / len(samples))
                milliseconds = round(frames / 16)
                if rms < 60 or max(abs(value) for value in samples) < 200:
                    return Transcript(status="no-speech", text="", durationMs=milliseconds, processingMs=round((time.monotonic() - started) * 1000))
                vad_options = ["--vad", "-vm", str(config.vad_model), "-vt", "0.35", "-vspd", "100", "-vsd", "500", "-vp", "150"] if config.vad_model else []
                await self.runner([str(config.whisper), "-m", str(config.model), "-f", str(normalized), "-l", "en", "-ng", "-t", "4", "-nf", "-sns", "-bs", "5", "--prompt", DEFAULT_PROMPT, *vad_options, "-otxt", "-of", str(output), "-np", "-nt"], config.timeout, "transcription-failed")
                transcript = output.with_suffix(".txt")
                try:
                    if transcript.stat().st_size > 16384:
                        raise ValueError()
                    text = " ".join(transcript.read_text(encoding="utf-8").split())
                    if len(text) > 4096 or any(ord(character) < 32 for character in text):
                        raise ValueError()
                except (OSError, ValueError):
                    raise VoiceError("transcription-failed") from None
                if text.lower() in {"[blank_audio]", "[silence]", "(silence)", "[no speech]"}:
                    text = ""
                return Transcript(status="ok" if text and any(character.isalnum() for character in text) else "no-speech", text=text if any(character.isalnum() for character in text) else "", durationMs=milliseconds, processingMs=round((time.monotonic() - started) * 1000))
        except OSError:
            raise VoiceError("transcription-failed") from None
        finally:
            self.busy = False
