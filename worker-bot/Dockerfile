FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/novda-worker-bot
COPY worker-bot/worker_bot.py ./worker_bot.py

USER 997:988
EXPOSE 8081
CMD ["python", "worker_bot.py"]
