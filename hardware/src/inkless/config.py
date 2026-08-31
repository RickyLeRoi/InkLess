# hardware/src/inkless/config.py

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    backend_url: str
    hardware_token: str
    printer_kind: str
    printer_spool_path: str
    printer_vendor_id: int
    printer_product_id: int
    recorder_kind: str
    webcam_device: str
    uploader_kind: str
    clips_directory: str
    overlay_path: str
    local_clips_directory: str
    public_clips_url: str
    s3_endpoint_url: str
    s3_access_key: str
    s3_secret_key: str
    s3_bucket: str
    reconnect_seconds: int


def _int(name: str, fallback: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    return int(raw, 0)


DEV_HARDWARE_TOKEN = "inkless-dev-hardware"


def _hardware_token(printer_kind: str, recorder_kind: str) -> str:
    """The shared secret, refusing to fall back to the development one on real hardware.

    20260831 ++ RG #no_dev_token_on_real_hardware
    The Node side already fails loud when HARDWARE_TOKEN is missing in production; this
    side quietly used the well-known development string instead. A node wired to the
    printer would come up, get 401 on every callback and print nothing, and the logs
    would blame the network rather than a missing variable.
    """
    token = os.environ.get("HARDWARE_TOKEN", "").strip()
    if token:
        return token

    if printer_kind != "fake" or recorder_kind != "fake":
        raise RuntimeError(
            "HARDWARE_TOKEN is required unless both PRINTER_KIND and RECORDER_KIND are fake"
        )
    return DEV_HARDWARE_TOKEN


def load_settings() -> Settings:
    """Everything unknown about this node comes from the environment.

    The defaults describe a laptop with no hardware attached, which is exactly the
    situation until the printer and the webcam are actually bought.
    """
    printer_kind = os.environ.get("PRINTER_KIND", "fake")
    recorder_kind = os.environ.get("RECORDER_KIND", "fake")

    return Settings(
        backend_url=os.environ.get("BACKEND_URL", "http://127.0.0.1:3000"),
        hardware_token=_hardware_token(printer_kind, recorder_kind),
        printer_kind=printer_kind,
        printer_spool_path=os.environ.get("PRINTER_SPOOL_PATH", "/tmp/inkless-spool.txt"),
        printer_vendor_id=_int("PRINTER_USB_VENDOR_ID", 0),
        printer_product_id=_int("PRINTER_USB_PRODUCT_ID", 0),
        recorder_kind=recorder_kind,
        webcam_device=os.environ.get("WEBCAM_DEVICE", "/dev/video0"),
        uploader_kind=os.environ.get("UPLOADER_KIND", "local"),
        clips_directory=os.environ.get("CLIPS_DIRECTORY", "/tmp/inkless-clips"),
        overlay_path=os.environ.get("OVERLAY_PATH", "/tmp/current_user.txt"),
        local_clips_directory=os.environ.get("LOCAL_CLIPS_DIRECTORY", "/tmp/inkless-public"),
        public_clips_url=os.environ.get("PUBLIC_CLIPS_URL", "http://localhost:8080/clips"),
        s3_endpoint_url=os.environ.get("S3_ENDPOINT_URL", ""),
        s3_access_key=os.environ.get("S3_ACCESS_KEY", ""),
        s3_secret_key=os.environ.get("S3_SECRET_KEY", ""),
        s3_bucket=os.environ.get("S3_BUCKET_NAME", ""),
        reconnect_seconds=_int("RECONNECT_SECONDS", 5),
    )
