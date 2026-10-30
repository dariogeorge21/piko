"""Bound requests before JSON parsing; never echo request content in errors."""

import asyncio
from fastapi import HTTPException

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .auth import valid_origin

MAX_BODY_BYTES = 512


class RequestBoundary:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def safe_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = [*(header for header in message.get("headers", []) if header[0] not in (b"cache-control", b"x-content-type-options")), (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff")]
            await send(message)

        async def reject(status: int, error: str):
            await JSONResponse({"error": error}, status_code=status)(scope, receive, safe_send)

        raw_headers = scope.get("headers", [])
        if sum(len(key) + len(value) for key, value in raw_headers) > 8192:
            await reject(431, "headers_too_large")
            return
        for name in (b"host", b"origin", b"x-piko-extension-origin", b"authorization", b"content-length", b"content-type"):
            if sum(key == name for key, _ in raw_headers) > 1:
                await reject(400, "invalid_request")
                return
        headers = dict(raw_headers)
        origin = headers.get(b"origin", b"").decode("latin1")
        declared = headers.get(b"x-piko-extension-origin", b"").decode("latin1")
        effective_origin = origin or declared or "*"
        scope.setdefault("state", {})["extension_origin"] = effective_origin
        if scope.get("query_string"):
            await reject(400, "query_not_supported")
            return
        length = headers.get(b"content-length", b"0")
        if not length.isdigit():
            await reject(400, "invalid_request")
            return
        if len(length) > 10:
            await reject(413, "body_too_large")
            return
        if scope["path"] == "/v1/transcribe" and scope["method"] == "POST":
            maximum = scope["app"].state.transcriber.config.max_bytes + 16384
            if int(length) > maximum:
                await reject(413, "audio-too-large")
                return
            count = 0
            finished = False
            deadline = asyncio.get_running_loop().time() + 15
            async def audio_receive():
                nonlocal count, finished
                if finished:
                    return await receive()
                try:
                    message = await asyncio.wait_for(receive(), timeout=max(0, deadline - asyncio.get_running_loop().time()))
                except asyncio.TimeoutError:
                    raise HTTPException(408, "invalid-audio") from None
                count += len(message.get("body", b""))
                if not message.get("more_body", False):
                    finished = True
                if count > maximum:
                    raise HTTPException(413, "audio-too-large")
                return message
            await self.app(scope, audio_receive, safe_send)
            return
        interpretation = scope["path"] in ("/v1/interpret", "/v1/summary") and scope["method"] == "POST"
        synthesis = scope["path"] == "/v1/synthesize" and scope["method"] == "POST"
        maximum = 131072 if interpretation else 8192 if synthesis else MAX_BODY_BYTES
        if int(length) > maximum:
            await reject(413, "body_too_large")
            return
        body = bytearray()
        deadline = asyncio.get_running_loop().time() + 3
        while True:
            try:
                message = await asyncio.wait_for(receive(), timeout=max(0, deadline - asyncio.get_running_loop().time()))
            except asyncio.TimeoutError:
                await reject(408, "request_timeout")
                return
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > maximum:
                await reject(413, "body_too_large")
                return
            if not message.get("more_body", False):
                break
        json_request = interpretation or synthesis or (scope["path"] == "/v1/pair" and scope["method"] == "POST")
        if body and not json_request:
            await reject(400, "body_not_supported")
            return
        if json_request and headers.get(b"content-type", b"").split(b";", 1)[0].strip().lower() != b"application/json":
            await reject(415, "json_required")
            return
        if interpretation or synthesis:
            from .services.ollama_client import strict_json
            try:
                strict_json(bytes(body))
            except (ValueError, UnicodeError, RecursionError):
                await reject(422, "invalid_request")
                return

        consumed = False
        async def bounded_receive():
            nonlocal consumed
            if consumed:
                return await receive()
            consumed = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, bounded_receive, safe_send)
