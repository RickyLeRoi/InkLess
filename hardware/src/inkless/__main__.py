# hardware/src/inkless/__main__.py

from __future__ import annotations

import logging
import signal
import threading
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
    return FakePrinter(settings.printer_spool_path)


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

    stopping = threading.Event()

    def connection_loop() -> None:
        while not stopping.is_set():
            try:
                # Catch-up first, stream second: anything paid for while this node was
                # down is in the table but was never pushed to anybody.
                for ticket in backend.pending_tickets():
                    worker.submit(ticket)

                for ticket in backend.stream_tickets():
                    worker.submit(ticket)

                if not stopping.is_set():
                    logger.warning("stream closed by the backend, reconnecting")
            except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
                if stopping.is_set():
                    return
                logger.warning("backend unreachable (%s), retrying", error)
            except Exception:  # noqa: BLE001 - the daemon must outlive any single failure
                # A socket we closed on the way out surfaces here; that is a shutdown,
                # not a crash worth a stack trace.
                if stopping.is_set():
                    return
                logger.exception("unexpected failure in the connection loop")

            # Waiting on the event, not sleeping: a signal during the backoff must not
            # cost a full reconnect window before the process may exit.
            stopping.wait(settings.reconnect_seconds)

    # 20260831 ** RG #clean_sigterm
    # The link runs on a daemon thread and the main thread only parks on the event.
    # Reading the stream means sitting inside a blocking recv, and a signal cannot get
    # anybody out of one: PEP 475 simply retries the syscall once the handler returns,
    # closed socket or not. A daemon thread instead dies with the interpreter, so the
    # shutdown path never has to interrupt a read it cannot interrupt.
    link = threading.Thread(target=connection_loop, name="backend-link", daemon=True)

    def shutdown(*_: object) -> None:
        # 20260831 ** RG #no_close_from_the_handler
        # Setting the flag is all this may do. Closing the stream from here deadlocks:
        # the buffered reader's close() wants the lock that the link thread is holding
        # while parked in recv, so the handler never returns and nothing ever stops.
        stopping.set()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    logger.info("daemon up, printer kind=%s recorder=%s", settings.printer_kind, settings.recorder_kind)
    link.start()

    # Interruptible on the main thread, so the handler above runs and releases this.
    stopping.wait()

    # Last thing, deliberately: a job already on the paper gets finished and reported
    # before the process goes away.
    worker.stop()
    logger.info("daemon stopped")


if __name__ == "__main__":
    main()
