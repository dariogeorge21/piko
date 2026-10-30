"""Authenticated route, cancellation, and session revalidation."""
import asyncio
from fastapi import Request
from ..schemas.interpret import InterpretRequest, InterpretResponse
from ..services.ollama_client import InterpretationError


async def interpret_request(payload: InterpretRequest, request: Request, authenticate) -> InterpretResponse:
    return await inference_request(payload, request, authenticate, request.app.state.interpreter.interpret)


async def inference_request(payload, request: Request, authenticate, operation):
    job = asyncio.create_task(operation(payload))
    disconnected = asyncio.create_task(request.receive())
    try:
        finished, _ = await asyncio.wait({job, disconnected}, return_when=asyncio.FIRST_COMPLETED)
        if disconnected in finished and disconnected.result().get("type") == "http.disconnect":
            raise InterpretationError("request-cancelled", 499)
        result = await job
        authenticate(request)
        return result
    finally:
        for task in (job, disconnected):
            if not task.done():
                task.cancel()
        await asyncio.gather(job, disconnected, return_exceptions=True)
