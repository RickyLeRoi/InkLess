# hardware/src/inkless/ports.py

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class PrintTicket:
    """A unit of work handed down by the backend."""

    job_id: str
    text: str
    attribution: str
    includes_video: bool

    @staticmethod
    def from_payload(payload: dict) -> "PrintTicket":
        return PrintTicket(
            job_id=payload["jobId"],
            text=payload["text"],
            attribution=payload["attribution"],
            includes_video=bool(payload.get("includesVideo", False)),
        )


class PrinterPort(Protocol):
    """The thermal printer, or something pretending to be one."""

    def print_ticket(self, ticket: PrintTicket) -> None: ...

    def is_ready(self) -> bool: ...


class RecorderPort(Protocol):
    """Captures the printer doing its thing."""

    def record(self, seconds: int, destination: str) -> str: ...


class UploaderPort(Protocol):
    """Puts a local file somewhere the browser can reach."""

    def upload(self, path: str) -> str: ...


class BackendPort(Protocol):
    """The Node backend on the home server."""

    def pending_tickets(self) -> list[PrintTicket]: ...

    def report_started(self, job_id: str) -> None: ...

    def report_completed(self, job_id: str, video_url: str | None) -> None: ...

    def report_failed(self, job_id: str, reason: str) -> None: ...
