# hardware/src/inkless/printer.py

from __future__ import annotations

import logging
from pathlib import Path

from .ports import PrintTicket

logger = logging.getLogger(__name__)

RECEIPT_WIDTH = 32
HEADER = "INKLESS"


def render_receipt(ticket: PrintTicket) -> str:
    """Lays the ticket out for a 32-column thermal roll.

    Kept separate from any device so the exact paper output can be asserted in tests
    without owning a printer.
    """
    rule = "-" * RECEIPT_WIDTH
    lines = [
        HEADER.center(RECEIPT_WIDTH),
        rule,
        *_wrap(ticket.text, RECEIPT_WIDTH),
        rule,
        *_wrap(ticket.attribution, RECEIPT_WIDTH),
        "",
        f"#{ticket.job_id[:8]}".center(RECEIPT_WIDTH),
    ]
    return "\n".join(lines)


def _wrap(text: str, width: int) -> list[str]:
    words = text.split()
    if not words:
        return [""]

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        if len(current) + 1 + len(word) <= width:
            current = f"{current} {word}"
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


class FakePrinter:
    """Development stand-in. Appends what would have been printed to a file."""

    def __init__(self, spool_path: str = "/tmp/inkless-spool.txt") -> None:
        self.spool_path = Path(spool_path)
        self.printed: list[PrintTicket] = []

    def print_ticket(self, ticket: PrintTicket) -> None:
        self.printed.append(ticket)
        rendered = render_receipt(ticket)
        self.spool_path.parent.mkdir(parents=True, exist_ok=True)
        with self.spool_path.open("a", encoding="utf-8") as handle:
            handle.write(rendered + "\n\n")
        logger.info("fake print for job %s", ticket.job_id)

    def is_ready(self) -> bool:
        return True


class EscPosPrinter:
    """Drives a real ESC/POS device over USB.

    python-escpos is imported lazily so the daemon still starts, and the fake path
    still works, on a machine where the library or the device is missing.
    """

    def __init__(self, vendor_id: int, product_id: int) -> None:
        self.vendor_id = vendor_id
        self.product_id = product_id
        self._device = None

    def _connect(self):
        if self._device is not None:
            return self._device
        from escpos.printer import Usb  # type: ignore[import-not-found]

        self._device = Usb(self.vendor_id, self.product_id)
        return self._device

    def print_ticket(self, ticket: PrintTicket) -> None:
        device = self._connect()
        device.set(align="center", bold=True)
        device.text(HEADER + "\n")
        device.set(align="left", bold=False)
        device.text("-" * RECEIPT_WIDTH + "\n")
        device.text("\n".join(_wrap(ticket.text, RECEIPT_WIDTH)) + "\n")
        device.text("-" * RECEIPT_WIDTH + "\n")
        device.set(bold=True)
        device.text("\n".join(_wrap(ticket.attribution, RECEIPT_WIDTH)) + "\n")
        device.set(bold=False)
        device.text(f"\n#{ticket.job_id[:8]}\n")
        device.cut()

    def is_ready(self) -> bool:
        try:
            self._connect()
            return True
        except Exception as error:  # noqa: BLE001 - any USB failure means "not ready"
            logger.warning("printer not reachable: %s", error)
            self._device = None
            return False
