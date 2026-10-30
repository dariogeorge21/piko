"""Trusted local configuration only; request bodies cannot select executables."""

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = 20


@dataclass(frozen=True)
class VoiceConfig:
    whisper: Path | None = None
    model: Path | None = None
    ffmpeg: Path | None = None
    ffprobe: Path | None = None
    timeout: int = 45
    max_bytes: int = MAX_AUDIO_BYTES
    max_seconds: int = MAX_AUDIO_SECONDS
    configured: bool = False
    vad_model: Path | None = None

    @classmethod
    def load(cls, env: Mapping[str, str] | None = None) -> "VoiceConfig":
        env = os.environ if env is None else env
        values = {}
        settings = Path(__file__).resolve().parents[1] / ".voice-config.json"
        try:
            if settings.is_file() and env is os.environ:
                if settings.stat().st_size > 8192:
                    return cls()
                values = json.loads(settings.read_text(encoding="utf-8"))
                if not isinstance(values, dict):
                    return cls()
            def setting(key, default=None):
                return env.get(key, values.get(key, default))
            paths = [Path(setting(key)).expanduser().resolve(strict=True) for key in ("WHISPER_CPP_CLI", "WHISPER_MODEL_PATH", "FFMPEG_PATH", "FFPROBE_PATH")]
            if not all(path.is_file() for path in paths) or setting("WHISPER_LANGUAGE", "en") != "en":
                return cls()
            timeout = int(setting("WHISPER_TIMEOUT_SECONDS", "45"))
            size = int(setting("MAX_AUDIO_BYTES", str(MAX_AUDIO_BYTES)))
            duration = int(setting("MAX_AUDIO_DURATION_SECONDS", str(MAX_AUDIO_SECONDS)))
            vad = Path(setting("WHISPER_VAD_MODEL_PATH")).expanduser().resolve(strict=True) if setting("WHISPER_VAD_MODEL_PATH") else None
            if vad is not None and not vad.is_file():
                return cls()
            if not (1 <= timeout <= 45 and 1 <= size <= MAX_AUDIO_BYTES and 1 <= duration <= MAX_AUDIO_SECONDS):
                return cls()
            return cls(*paths, timeout, size, duration, True, vad)
        except (OSError, ValueError, TypeError):
            return cls()
