# hardware/tests/test_backend.py

from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from inkless.backend import HttpBackend  # noqa: E402

RECEIVED: list[dict] = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        length = int(self.headers.get("Content-Length") or 0)
        RECEIVED.append(
            {
                "path": self.path,
                "content_type": self.headers.get("Content-Type"),
                "authorization": self.headers.get("Authorization"),
                "body": self.rfile.read(length).decode("utf-8") if length else "",
            }
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self) -> None:  # noqa: N802
        payload = json.dumps(
            {
                "items": [
                    {
                        "jobId": "job-1",
                        "text": "ciao",
                        "attribution": "Scritto e stampato da: @ricky",
                        "includesVideo": True,
                    }
                ]
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: object) -> None:
        pass


class HttpBackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.backend = HttpBackend(f"http://{host}:{port}", "test-token")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    def setUp(self) -> None:
        RECEIVED.clear()

    def test_bodyless_post_does_not_claim_a_json_body(self) -> None:
        """Regression: Fastify answers 400 to application/json with an empty body."""
        self.backend.report_started("job-1")

        sent = RECEIVED[0]
        self.assertEqual(sent["body"], "")
        self.assertIsNone(sent["content_type"])

    def test_post_with_payload_declares_json(self) -> None:
        self.backend.report_failed("job-1", "printer offline")

        sent = RECEIVED[0]
        self.assertEqual(sent["content_type"], "application/json")
        self.assertEqual(json.loads(sent["body"]), {"reason": "printer offline"})

    def test_completion_without_a_clip_still_sends_an_object(self) -> None:
        self.backend.report_completed("job-1", None)

        sent = RECEIVED[0]
        self.assertEqual(sent["content_type"], "application/json")
        self.assertEqual(json.loads(sent["body"]), {})

    def test_sends_the_bearer_token(self) -> None:
        self.backend.report_started("job-1")

        self.assertEqual(RECEIVED[0]["authorization"], "Bearer test-token")

    def test_parses_the_catch_up_queue(self) -> None:
        tickets = self.backend.pending_tickets()

        self.assertEqual(len(tickets), 1)
        self.assertEqual(tickets[0].job_id, "job-1")
        self.assertTrue(tickets[0].includes_video)


if __name__ == "__main__":
    unittest.main()
