# hardware/src/inkless/backend.py

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from collections.abc import Iterator

from .ports import PrintTicket

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10


class HttpBackend:
    """Talks to the Node backend over the segregated LAN link.

    Plain urllib: the traffic never leaves the local network, so there is nothing
    here worth a dependency.
    """

    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None

        # 20260831 ** RG #empty_json_body_rejected
        # Declaring application/json on a bodyless POST makes Fastify answer 400.
        # The status callbacks carry no payload, so the header goes on only with one.
        headers = {"Authorization": f"Bearer {self.token}"}
        if body is not None:
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}

    def pending_tickets(self) -> list[PrintTicket]:
        payload = self._request("GET", "/internal/jobs/queued")
        return [PrintTicket.from_payload(item) for item in payload.get("items", [])]

    def report_started(self, job_id: str) -> None:
        self._request("POST", f"/internal/jobs/{job_id}/start")

    def report_completed(self, job_id: str, video_url: str | None) -> None:
        payload = {"videoUrl": video_url} if video_url else {}
        self._request("POST", f"/internal/jobs/{job_id}/complete", payload)

    def report_failed(self, job_id: str, reason: str) -> None:
        self._request("POST", f"/internal/jobs/{job_id}/fail", {"reason": reason[:200]})

    def stream_tickets(self) -> Iterator[PrintTicket]:
        """Yields tickets as the backend pushes them over SSE.

        Returns when the connection drops, leaving reconnection (and the catch-up
        fetch that must follow it) to the caller.
        """
        request = urllib.request.Request(
            f"{self.base_url}/internal/print-stream",
            headers={"Authorization": f"Bearer {self.token}", "Accept": "text/event-stream"},
        )

        with urllib.request.urlopen(request) as response:
            event_name = ""
            for raw_line in response:
                line = raw_line.decode("utf-8").rstrip("\n")

                if line.startswith(":"):
                    continue
                if line.startswith("event:"):
                    event_name = line[6:].strip()
                    continue
                if line.startswith("data:"):
                    data = line[5:].strip()
                    if event_name == "ticket":
                        yield PrintTicket.from_payload(json.loads(data))
                    event_name = ""
