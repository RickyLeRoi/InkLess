# hardware/src/inkless/media.py

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


class FakeRecorder:
    """Writes a placeholder file instead of touching a camera."""

    def __init__(self) -> None:
        self.recordings: list[str] = []

    def record(self, seconds: int, destination: str) -> str:
        path = Path(destination)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"fake-recording")
        self.recordings.append(destination)
        logger.info("fake recording of %ss at %s", seconds, destination)
        return destination


class FfmpegRecorder:
    """Grabs a clip from V4L2 using the Pi's hardware H.264 encoder.

    20260830 ++ RG #hardware_encoding
    -c:v h264_v4l2m2m keeps the encode off the CPU: software x264 on a Pi 4 cannot
    hold the frame rate while the printer is also being driven.
    """

    def __init__(self, device: str, resolution: str = "1280x720", framerate: int = 25) -> None:
        self.device = device
        self.resolution = resolution
        self.framerate = framerate

    def record(self, seconds: int, destination: str) -> str:
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("ffmpeg is not installed on this node")

        Path(destination).parent.mkdir(parents=True, exist_ok=True)
        command = [
            "ffmpeg",
            "-y",
            "-f", "v4l2",
            "-framerate", str(self.framerate),
            "-video_size", self.resolution,
            "-i", self.device,
            "-t", str(seconds),
            "-c:v", "h264_v4l2m2m",
            "-b:v", "2M",
            destination,
        ]
        subprocess.run(command, check=True, capture_output=True, timeout=seconds + 30)
        return destination


class LocalUploader:
    """Copies the clip into a directory the backend serves. No cloud, no keys."""

    def __init__(self, directory: str, public_base_url: str) -> None:
        self.directory = Path(directory)
        self.public_base_url = public_base_url.rstrip("/")

    def upload(self, path: str) -> str:
        self.directory.mkdir(parents=True, exist_ok=True)
        name = Path(path).name
        shutil.copy2(path, self.directory / name)
        return f"{self.public_base_url}/{name}"


class S3Uploader:
    """Pushes the clip to an S3-compatible bucket such as Cloudflare R2.

    boto3 is imported lazily: a node configured for local storage must not need it.
    """

    def __init__(
        self,
        endpoint_url: str,
        access_key: str,
        secret_key: str,
        bucket: str,
        public_base_url: str,
    ) -> None:
        self.endpoint_url = endpoint_url
        self.access_key = access_key
        self.secret_key = secret_key
        self.bucket = bucket
        self.public_base_url = public_base_url.rstrip("/")

    def upload(self, path: str) -> str:
        import boto3  # type: ignore[import-not-found]

        client = boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            aws_access_key_id=self.access_key,
            aws_secret_access_key=self.secret_key,
        )
        name = Path(path).name
        client.upload_file(path, self.bucket, name, ExtraArgs={"ContentType": "video/mp4"})
        return f"{self.public_base_url}/{name}"
