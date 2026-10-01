FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/novda-admin-bot
COPY admin-bot/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY admin-bot/admin_bot.py ./admin_bot.py
COPY admin-bot/license_payload.py ./license_payload.py

USER 997:988
EXPOSE 8080
CMD ["python", "admin_bot.py"]
