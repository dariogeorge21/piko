"""Authenticated loopback companion with bounded local inference and speech."""

import time
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Annotated, Callable, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from starlette.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartParser, MultiPartException
from starlette.requests import ClientDisconnect
from python_multipart.exceptions import MultipartParseError

from .auth import ORIGIN_PATTERN, PairingManager, Session
from .boundary import RequestBoundary
from .voice_config import VoiceConfig, MAX_AUDIO_BYTES
from .transcription import Transcriber, Transcript, VoiceError
from .services.ollama_client import OllamaClient, InterpretationError
from .services.interpretation_service import InterpretationService
from .schemas.interpret import InterpretRequest, InterpretResponse
from .api.interpret import interpret_request, inference_request
from .schemas.summary import SummaryRequest, SummaryResponse
from .services.piper_service import PiperService, SpeechError
from .schemas.synthesize import SynthesizeRequest
from .api.synthesize import synthesize_request


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HealthResponse(StrictModel):
    status: Literal["ok"] = "ok"
    service: Literal["local-voice-form-assistant"] = "local-voice-form-assistant"
    version: Literal["0.1.0"] = "0.1.0"
    inference: Literal["local_ollama"] = "local_ollama"
    protocol_version: Literal[1] = 1


class PairRequest(StrictModel):
    protocol_version: int = Field(ge=1, le=10000)
    code: str | None = Field(default=None)


class PairResponse(StrictModel):
    protocol_version: Literal[1] = 1
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    expires_at: int


class CapabilitiesResponse(StrictModel):
    protocol_version: Literal[1] = 1
    inference: Literal["ready", "unavailable"]
    transcription: Literal["ready", "unavailable"]
    speech_synthesis: Literal["ready", "unavailable"]
    speech_synthesis_detail: Literal['speech-configuration-invalid', 'speech-voice-missing', 'speech-voice-invalid', 'speech-unavailable'] | None = None


class PingResponse(StrictModel):
    protocol_version: Literal[1] = 1
    status: Literal["ok"] = "ok"


class DisconnectResponse(StrictModel):
    protocol_version: Literal[1] = 1
    status: Literal["disconnected"] = "disconnected"


def authenticate(request: Request) -> Session:
    return request.app.state.pairing.authenticate(request.headers.get("authorization", ""), getattr(request.state, "extension_origin", "*"))


def create_app(clock: Callable[[], float] = time.monotonic, wall_clock: Callable[[], float] = time.time, announce: Callable[[str], None] | None = None, voice_config: VoiceConfig | None = None, transcriber: Transcriber | None = None, ollama_client: OllamaClient | None = None, piper_service: PiperService | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        manager = PairingManager(clock, wall_clock)
        application.state.pairing = manager
        application.state.transcriber = transcriber or Transcriber(voice_config if voice_config is not None else VoiceConfig.load())
        application.state.ollama = ollama_client or OllamaClient()
        application.state.interpreter = InterpretationService(application.state.ollama)
        application.state.speech = piper_service or PiperService()
        try:
            await application.state.speech.start()
            if not application.state.transcriber.config.configured:
                logging.getLogger("piko.service").warning("Local speech recognition is unavailable; configure the local executables and model.")
            manager.start()
            line = "Piko companion service running on http://127.0.0.1:8765"
            if announce is None:
                print(line, flush=True)
            else:
                announce(line)
            del line
            yield
        finally:
            manager.clear()
            try:
                await application.state.speech.close()
            finally:
                await application.state.ollama.close()

    application = FastAPI(title="Local Voice Form Assistant Service", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    application.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], allow_credentials=False, max_age=60)
    application.add_middleware(RequestBoundary)

    @application.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, _error: RequestValidationError):
        if request.url.path == "/v1/pair":
            try:
                request.app.state.pairing.fail_pairing()
            except HTTPException as error:
                return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)
        return JSONResponse({"error": "invalid_request"}, status_code=422)

    @application.exception_handler(HTTPException)
    async def api_error(_request: Request, error: HTTPException):
        return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)

    @application.exception_handler(VoiceError)
    async def voice_error(_request: Request, error: VoiceError):
        return JSONResponse({"error": error.code}, status_code=error.status)

    @application.exception_handler(InterpretationError)
    async def interpretation_error(_request: Request, error: InterpretationError):
        return JSONResponse({"error": error.code}, status_code=error.status)

    @application.exception_handler(SpeechError)
    async def speech_error(_request: Request, error: SpeechError):
        return JSONResponse({"error": error.code}, status_code=error.status)

    @application.get("/v1/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse()

    @application.post("/v1/pair", response_model=PairResponse)
    async def pair(payload: PairRequest, request: Request) -> PairResponse:
        if payload.protocol_version != 1:
            raise HTTPException(426, "unsupported_protocol")
        token, expires_at = request.app.state.pairing.pair(payload.code or "", getattr(request.state, "extension_origin", "*"))
        return PairResponse(token=token, expires_at=expires_at)

    @application.get("/v1/capabilities", response_model=CapabilitiesResponse)
    async def capabilities(request: Request, _session: Annotated[Session, Depends(authenticate)]) -> CapabilitiesResponse:
        speech = request.app.state.speech
        return CapabilitiesResponse(speech_synthesis="ready" if speech.ready else "unavailable", speech_synthesis_detail=None if speech.ready else speech.reason or 'speech-unavailable', inference="ready" if await request.app.state.ollama.available() else "unavailable", transcription="ready" if request.app.state.transcriber.config.configured else "unavailable")

    @application.post("/v1/interpret", response_model=InterpretResponse)
    async def interpret(payload: InterpretRequest, request: Request, _session: Annotated[Session, Depends(authenticate)]) -> InterpretResponse:
        return await interpret_request(payload, request, authenticate)

    @application.post('/v1/summary', response_model=SummaryResponse)
    async def summarize(payload: SummaryRequest, request: Request, _session: Annotated[Session, Depends(authenticate)]) -> SummaryResponse:
        return await inference_request(payload, request, authenticate, request.app.state.interpreter.summarize)

    @application.post("/v1/synthesize")
    async def synthesize(payload: SynthesizeRequest, request: Request, _session: Annotated[Session, Depends(authenticate)]) -> Response:
        return await synthesize_request(payload, request, authenticate)

    @application.post("/v1/transcribe", response_model=Transcript)
    async def transcribe_audio(request: Request, _session: Annotated[Session, Depends(authenticate)]) -> Transcript:
        if not request.app.state.transcriber.config.configured:
            raise VoiceError("model-unavailable", 503)
        if not request.headers.get("content-type", "").lower().startswith("multipart/form-data;"):
            raise VoiceError("unsupported-audio", 415)
        # Keep multipart spooling in bounded memory. Only the pipeline writes
        # randomized per-request files, and cleans them on every exit path.
        parser = MultiPartParser(request.headers, request.stream(), max_files=1, max_fields=0, max_part_size=MAX_AUDIO_BYTES)
        parser.spool_max_size = MAX_AUDIO_BYTES + 16385
        job = disconnect = None
        try:
            form = await parser.parse()
            items = form.multi_items()
            if len(items) != 1 or items[0][0] != "file" or not isinstance(items[0][1], UploadFile):
                raise VoiceError("invalid-audio")
            upload = items[0][1]
            data = bytearray()
            while chunk := await upload.read(65536):
                data.extend(chunk)
                if len(data) > request.app.state.transcriber.config.max_bytes:
                    raise VoiceError("audio-too-large", 413)
            job = asyncio.create_task(request.app.state.transcriber.transcribe(bytes(data)))
            data.clear()
            # Await disconnect directly: polling is_disconnected() uses a
            # cancellation scope that can swallow an outer request cancellation.
            disconnect = asyncio.create_task(request.receive())
            finished, _ = await asyncio.wait({job, disconnect}, return_when=asyncio.FIRST_COMPLETED)
            if disconnect in finished:
                raise VoiceError("request-cancelled", 499)
            # A session revoked/expired during inference cannot return a result.
            authenticate(request)
            return await job
        except (MultiPartException, MultipartParseError):
            raise VoiceError("invalid-audio") from None
        except ClientDisconnect:
            raise VoiceError("request-cancelled", 499) from None
        finally:
            tasks = [task for task in (job, disconnect) if task is not None]
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for temporary in parser._files_to_close_on_error:
                temporary.close()

    @application.get("/v1/ping", response_model=PingResponse)
    async def ping(_session: Annotated[Session, Depends(authenticate)]) -> PingResponse:
        return PingResponse()

    @application.delete("/v1/session", response_model=DisconnectResponse)
    async def disconnect(request: Request, _session: Annotated[Session, Depends(authenticate)]) -> DisconnectResponse:
        request.app.state.pairing.session = None
        return DisconnectResponse()

    return application


app = create_app()
