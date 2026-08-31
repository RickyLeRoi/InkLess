# hardware/src/inkless/worker.py

from __future__ import annotations

import logging
import queue
import threading
from pathlib import Path

from .ports import BackendPort, PrinterPort, PrintTicket, RecorderPort, UploaderPort

logger = logging.getLogger(__name__)

CLIP_SECONDS = 15


class PrintWorker:
    """Serialises every job onto a single thread.

    20260830 ++ RG #single_consumer
    One consumer, never a pool: ESC/POS is a stateful byte stream on one device, so
    two overlapping jobs would interleave their commands and produce garbage paper.
    """

    def __init__(
        self,
        backend: BackendPort,
        printer: PrinterPort,
        recorder: RecorderPort,
        uploader: UploaderPort,
        clips_directory: str = "/tmp/inkless-clips",
        overlay_path: str = "/tmp/current_user.txt",
    ) -> None:
        self.backend = backend
        self.printer = printer
        self.recorder = recorder
        self.uploader = uploader
        self.clips_directory = Path(clips_directory)
        self.overlay_path = Path(overlay_path)

        self._queue: queue.Queue[PrintTicket | None] = queue.Queue()
        self._seen: set[str] = set()
        self._seen_lock = threading.Lock()
        self._thread: threading.Thread | None = None

    def submit(self, ticket: PrintTicket) -> bool:
        """Enqueues a ticket unless this job has already been taken.

        The catch-up fetch and the live stream legitimately overlap, so the same job
        arrives twice on every reconnect. Without this guard the payer would be
        charged once and printed twice.
        """
        with self._seen_lock:
            if ticket.job_id in self._seen:
                logger.debug("ignoring duplicate job %s", ticket.job_id)
                return False
            self._seen.add(ticket.job_id)

        self._queue.put(ticket)
        return True

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._consume, name="print-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._queue.put(None)
        if self._thread is not None:
            self._thread.join(timeout=CLIP_SECONDS + 30)
            self._thread = None

    def drain(self, timeout: float | None = None) -> None:
        """Blocks until the queue is empty. Used by the tests."""
        self._queue.join()

    def _consume(self) -> None:
        while True:
            ticket = self._queue.get()
            if ticket is None:
                self._queue.task_done()
                return
            try:
                self.process(ticket)
            except Exception as error:  # noqa: BLE001 - a bad job must not kill the daemon
                logger.exception("job %s failed", ticket.job_id)
                self._safely_report_failure(ticket.job_id, str(error))
            finally:
                self._queue.task_done()

    def process(self, ticket: PrintTicket) -> None:
        self.backend.report_started(ticket.job_id)
        self._write_overlay(ticket.attribution)

        recording: dict[str, str | None] = {"path": None}
        recorder_thread: threading.Thread | None = None

        if ticket.includes_video:
            destination = str(self.clips_directory / f"{ticket.job_id}.mp4")

            def capture() -> None:
                try:
                    recording["path"] = self.recorder.record(CLIP_SECONDS, destination)
                except Exception:  # noqa: BLE001 - a lost clip must not lose the print
                    logger.exception("recording failed for job %s", ticket.job_id)

            # The camera has to be rolling before the paper starts moving, otherwise
            # the clip misses the only moment anybody paid to see.
            recorder_thread = threading.Thread(target=capture, name=f"rec-{ticket.job_id[:8]}")
            recorder_thread.start()

        self.printer.print_ticket(ticket)

        if recorder_thread is not None:
            recorder_thread.join()

        video_url = None
        if recording["path"]:
            try:
                video_url = self.uploader.upload(recording["path"])
            except Exception:  # noqa: BLE001 - the paper is out; do not fail the job
                logger.exception("upload failed for job %s", ticket.job_id)

        self.backend.report_completed(ticket.job_id, video_url)

    def _write_overlay(self, attribution: str) -> None:
        """Feeds the live stream's drawtext filter, which re-reads this file."""
        try:
            self.overlay_path.parent.mkdir(parents=True, exist_ok=True)
            self.overlay_path.write_text(attribution, encoding="utf-8")
        except OSError:
            logger.warning("could not update the overlay file")

    def _safely_report_failure(self, job_id: str, reason: str) -> None:
        try:
            self.backend.report_failed(job_id, reason)
        except Exception:  # noqa: BLE001 - the backend may be the thing that is down
            logger.exception("could not report the failure of job %s", job_id)
