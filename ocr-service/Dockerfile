# ocr-service/Dockerfile
FROM jbarlow83/ocrmypdf:v17.7.0
# L'image fournit ocrmypdf + tesseract. On ajoute le pack langue FR + un serveur HTTP.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr-fra python3-pip \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /app/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /app/requirements.txt
COPY app.py /app/app.py
WORKDIR /app
USER 1000:1000
ENTRYPOINT []
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "620", "app:app"]
