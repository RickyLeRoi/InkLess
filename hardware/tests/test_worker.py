# hardware/tests/test_worker.py

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from inkless.media import FakeRecorder  # noqa: E402
from inkless.ports import PrintTicket  # noqa: E402
from inkless.printer import FakePrinter, render_receipt  # noqa: E402
from inkless.worker import PrintWorker  # noqa: E402


class RecordingBackend:
    def __init__(self) -> None:
        self.started: list[str] = []
        self.completed: list[tuple[str, str | None]] = []
        self.failed: list[tuple[str, str]] = []

    def pending_tickets(self) -> list[PrintTicket]:
        return []

    def report_started(self, job_id: str) -> None:
        self.started.append(job_id)

    def report_completed(self, job_id: str, video_url: str | None) -> None:
        self.completed.append((job_id, video_url))

    def report_failed(self, job_id: str, reason: str) -> None:
        self.failed.append((job_id, reason))


class StubUploader:
    def __init__(self) -> None:
        self.uploaded: list[str] = []

    def upload(self, path: str) -> str:
        self.uploaded.append(path)
        return f"https://clips.test/{Path(path).name}"


class ExplodingPrinter:
    def print_ticket(self, ticket: PrintTicket) -> None:
        raise RuntimeError("printer offline")

    def is_ready(self) -> bool:
        return False


def ticket(job_id: str = "job-1", includes_video: bool = False) -> PrintTicket:
    return PrintTicket(
        job_id=job_id,
        text="un messaggio da stampare",
        attribution="Scritto da: @autore - Stampato da: @stampatore",
        includes_video=includes_video,
    )


class WorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = RecordingBackend()
        self.printer = FakePrinter(spool_path="/tmp/inkless-test-spool.txt")
        self.recorder = FakeRecorder()
        self.uploader = StubUploader()
        self.worker = PrintWorker(
            backend=self.backend,
            printer=self.printer,
            recorder=self.recorder,
            uploader=self.uploader,
            clips_directory="/tmp/inkless-test-clips",
            overlay_path="/tmp/inkless-test-overlay.txt",
        )

    def test_prints_and_reports_completion(self) -> None:
        self.worker.process(ticket())

        self.assertEqual(self.backend.started, ["job-1"])
        self.assertEqual(self.backend.completed, [("job-1", None)])
        self.assertEqual(len(self.printer.printed), 1)

    def test_records_and_uploads_for_the_video_tier(self) -> None:
        self.worker.process(ticket(includes_video=True))

        self.assertEqual(len(self.recorder.recordings), 1)
        self.assertEqual(len(self.uploader.uploaded), 1)
        job_id, video_url = self.backend.completed[0]
        self.assertEqual(job_id, "job-1")
        self.assertTrue(video_url.endswith("job-1.mp4"))

    def test_skips_recording_below_the_video_tier(self) -> None:
        self.worker.process(ticket(includes_video=False))

        self.assertEqual(self.recorder.recordings, [])
        self.assertEqual(self.uploader.uploaded, [])

    def test_writes_the_overlay_for_the_live_stream(self) -> None:
        self.worker.process(ticket())

        overlay = Path("/tmp/inkless-test-overlay.txt").read_text(encoding="utf-8")
        self.assertIn("@stampatore", overlay)

    def test_reports_failure_when_the_printer_is_down(self) -> None:
        worker = PrintWorker(
            backend=self.backend,
            printer=ExplodingPrinter(),
            recorder=self.recorder,
            uploader=self.uploader,
        )
        worker.start()
        worker.submit(ticket("job-down"))
        worker.drain()
        worker.stop()

        self.assertEqual(self.backend.completed, [])
        self.assertEqual(len(self.backend.failed), 1)
        self.assertEqual(self.backend.failed[0][0], "job-down")

    def test_ignores_a_job_already_taken(self) -> None:
        self.assertTrue(self.worker.submit(ticket("job-dup")))
        self.assertFalse(self.worker.submit(ticket("job-dup")))

    def test_survives_a_failed_recording(self) -> None:
        class BrokenRecorder:
            def record(self, seconds: int, destination: str) -> str:
                raise RuntimeError("camera busy")

        worker = PrintWorker(
            backend=self.backend,
            printer=self.printer,
            recorder=BrokenRecorder(),
            uploader=self.uploader,
        )
        worker.process(ticket("job-noclip", includes_video=True))

        self.assertEqual(self.backend.completed, [("job-noclip", None)])
        self.assertEqual(len(self.printer.printed), 1)


class ReceiptLayoutTest(unittest.TestCase):
    def test_wraps_to_the_paper_width(self) -> None:
        long_ticket = PrintTicket(
            job_id="abcdef123456",
            text="parola " * 20,
            attribution="Scritto e stampato da: @qualcuno",
            includes_video=False,
        )
        rendered = render_receipt(long_ticket)

        self.assertTrue(all(len(line) <= 32 for line in rendered.split("\n")))
        self.assertIn("INKLESS", rendered)
        self.assertIn("#abcdef12", rendered)


if __name__ == "__main__":
    unittest.main()
