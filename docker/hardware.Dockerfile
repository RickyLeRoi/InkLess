# docker/hardware.Dockerfile

FROM python:3.11-slim

WORKDIR /app

# libusb is what python-escpos talks to; ffmpeg does the capture. Both are skipped
# by the fake adapters, but the image is built once for the real node.
RUN apt-get update \
  && apt-get install --no-install-recommends -y libusb-1.0-0 ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY hardware/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY hardware/src ./src

# Runs unprivileged: the compose file grants the two specific devices instead.
RUN useradd --create-home --shell /usr/sbin/nologin inkless \
  && mkdir -p /tmp/inkless-clips \
  && chown -R inkless /app /tmp/inkless-clips

USER inkless

ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

CMD ["python", "-m", "inkless"]
