# hardware/src/inkless/__main__.py

from __future__ import annotations

import logging
import signal
import time
import urllib.error

from .backend import HttpBackend
from .config import Settings, load_settings
from .media import FakeRecorder, FfmpegRecorder, LocalUploader, S3Uploader
from .printer import EscPosPrinter, FakePrinter
from .worker import PrintWorker

logger = logging.getLogger("inkless")


def build_printer(settings: Settings):
    if settings.printer_kind == "escpos":
        return EscPosPrinter(settings.printer_vendor_id, settings.printer_product_id)
    return FakePrinter()


def build_recorder(settings: Settings):
    if settings.recorder_kind == "ffmpeg":
        return FfmpegRecorder(settings.webcam_device)
    return FakeRecorder()


def build_uploader(settings: Settings):
    if settings.uploader_kind == "s3":
        return S3Uploader(
            endpoint_url=settings.s3_endpoint_url,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            bucket=settings.s3_bucket,
            public_base_url=settings.public_clips_url,
        )
    return LocalUploader(settings.local_clips_directory, settings.public_clips_url)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    settings = load_settings()
    backend = HttpBackend(settings.backend_url, settings.hardware_token)
    worker = PrintWorker(
        backend=backend,
        printer=build_printer(settings),
        recorder=build_recorder(settings),
        uploader=build_uploader(settings),
        clips_directory=settings.clips_directory,
        overlay_path=settings.overlay_path,
    )
    worker.start()

    running = True

    def shutdown(*_: object) -> None:
        nonlocal running
        running = False
        worker.stop()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    logger.info("daemon up, printer kind=%s recorder=%s", settings.printer_kind, settings.recorder_kind)

    while running:
        try:
            # Catch-up first, stream second: anything paid for while this node was
            # down is in the table but was never pushed to anybody.
            for ticket in backend.pending_tickets():
                worker.submit(ticket)

            for ticket in backend.stream_tickets():
                worker.submit(ticket)

            logger.warning("stream closed by the backend, reconnecting")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
            logger.warning("backend unreachable (%s), retrying", error)
        except Exception:  # noqa: BLE001 - the daemon must outlive any single failure
            logger.exception("unexpected failure in the connection loop")

        if running:
            time.sleep(settings.reconnect_seconds)


if __name__ == "__main__":
    main()
