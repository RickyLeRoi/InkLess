# hardware/tests/test_config.py

import os
import unittest
from unittest import mock

from inkless.config import DEV_HARDWARE_TOKEN, load_settings


def _env(**overrides: str) -> dict:
    """A clean environment, so the developer's own exports cannot decide the outcome."""
    return {key: value for key, value in overrides.items()}


class HardwareTokenTest(unittest.TestCase):
    """20260831 ++ RG #no_dev_token_on_real_hardware

    The Node side refuses to start without HARDWARE_TOKEN in production. This side used
    to fall back to the well-known development string in silence, so a node wired to the
    printer would come up, take 401 on every callback and print nothing, while the logs
    pointed at the network instead of at a missing variable.
    """

    def test_falls_back_to_the_dev_token_only_with_fake_hardware(self) -> None:
        with mock.patch.dict(os.environ, _env(), clear=True):
            self.assertEqual(load_settings().hardware_token, DEV_HARDWARE_TOKEN)

    def test_refuses_the_fallback_once_a_real_printer_is_configured(self) -> None:
        with mock.patch.dict(os.environ, _env(PRINTER_KIND="escpos"), clear=True):
            with self.assertRaises(RuntimeError):
                load_settings()

    def test_refuses_the_fallback_once_a_real_camera_is_configured(self) -> None:
        with mock.patch.dict(os.environ, _env(RECORDER_KIND="ffmpeg"), clear=True):
            with self.assertRaises(RuntimeError):
                load_settings()

    def test_a_real_node_starts_when_the_token_is_supplied(self) -> None:
        environment = _env(PRINTER_KIND="escpos", RECORDER_KIND="ffmpeg", HARDWARE_TOKEN="s3cret")
        with mock.patch.dict(os.environ, environment, clear=True):
            settings = load_settings()
        self.assertEqual(settings.hardware_token, "s3cret")
        self.assertEqual(settings.printer_kind, "escpos")
        self.assertEqual(settings.recorder_kind, "ffmpeg")

    def test_whitespace_is_not_a_token(self) -> None:
        with mock.patch.dict(os.environ, _env(PRINTER_KIND="escpos", HARDWARE_TOKEN="   "), clear=True):
            with self.assertRaises(RuntimeError):
                load_settings()


if __name__ == "__main__":
    unittest.main()
