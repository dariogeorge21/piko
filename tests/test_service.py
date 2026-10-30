"""Step 7 API, open access, and service checks without pairing code requirements."""

import io
import runpy
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps/local-service"))

from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock
from app.main import create_app
from app.services.piper_service import PiperService, PiperConfig

def no_speech():
    return PiperService(PiperConfig(voice_path=Path(__file__).parent / "fixtures/missing-voice.onnx"))

from app.voice_config import VoiceConfig

ORIGIN = "chrome-extension://" + "a" * 32
OTHER = "https://example.test"


class LauncherTests(unittest.TestCase):
    def test_default_launcher_is_loopback_only_without_access_logs_or_proxies(self):
        with patch("uvicorn.run") as run:
            runpy.run_module("app", run_name="__main__")
        run.assert_called_once_with("app.main:app", host="127.0.0.1", port=8765, reload=False, access_log=False, proxy_headers=False)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 1000.0
        self.announcements = []
        self.app = create_app(lambda: self.now, lambda: 1_800_000_000 + self.now, self.announcements.append, voice_config=VoiceConfig(), piper_service=no_speech())
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.addAsyncCleanup(self.lifespan.__aexit__, None, None, None)
        self.app.state.ollama.available = AsyncMock(return_value=False)
        self.client = AsyncClient(transport=ASGITransport(app=self.app), base_url="http://127.0.0.1:8765", headers={"Origin": ORIGIN})
        self.addAsyncCleanup(self.client.aclose)

    async def pair(self):
        response = await self.client.post("/v1/pair", json={"protocol_version": 1})
        self.assertEqual(response.status_code, 200)
        return response.json()["token"]

    async def test_health_without_authentication(self):
        response = await self.client.get("/v1/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "service": "local-voice-form-assistant", "version": "0.1.0", "inference": "local_ollama", "protocol_version": 1})
        self.assertEqual(response.headers["cache-control"], "no-store")
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://127.0.0.1:8765") as client:
            self.assertEqual((await client.get("/v1/health")).status_code, 200)

    async def test_open_access_capabilities_ping_without_token(self):
        response = await self.client.get("/v1/ping")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"protocol_version": 1, "status": "ok"})
        capabilities = await self.client.get("/v1/capabilities")
        self.assertEqual(capabilities.status_code, 200)
        self.assertEqual(capabilities.json()["protocol_version"], 1)

    async def test_pairing_endpoint_succeeds_without_code(self):
        token = await self.pair()
        self.assertEqual(len(token), 43)
        headers = {"Authorization": f"Bearer {token}"}
        self.assertEqual((await self.client.get("/v1/ping", headers=headers)).json(), {"protocol_version": 1, "status": "ok"})

    async def test_cors_allows_open_access_for_any_origin(self):
        headers = {"Origin": OTHER, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type"}
        response = await self.client.options("/v1/pair", headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "*")

    async def test_unsupported_protocol(self):
        response = await self.client.post("/v1/pair", json={"protocol_version": 2})
        self.assertEqual(response.status_code, 426)

    async def test_only_intended_service_routes_and_no_remote_documentation(self):
        self.assertEqual(set(self.app.openapi()["paths"]), {"/v1/health", "/v1/pair", "/v1/ping", "/v1/capabilities", "/v1/session", "/v1/transcribe", "/v1/interpret", "/v1/synthesize", "/v1/summary"})
        for route in ("/interpret", "/api/v1/interpret", "/transcribe", "/synthesize", "/forms", "/docs", "/redoc", "/openapi.json"):
            self.assertEqual((await self.client.get(route)).status_code, 404)

    async def test_startup_announcement_without_pairing_code(self):
        stream = io.StringIO()
        standalone = create_app(piper_service=no_speech())
        with redirect_stdout(stream):
            async with standalone.router.lifespan_context(standalone):
                printed = stream.getvalue()
                self.assertNotIn("Piko pairing code", printed)
                self.assertIn("Piko companion service running", printed)


if __name__ == "__main__":
    unittest.main()
