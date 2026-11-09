FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/novda-admin-bot
COPY apps/bots/admin/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/bots/admin/admin_bot.py ./admin_bot.py
COPY apps/bots/admin/license_payload.py ./license_payload.py

USER 997:988
EXPOSE 8080
CMD ["python", "admin_bot.py"]
