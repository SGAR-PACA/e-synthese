# ocr-service/app.py
# Microservice OCR : reçoit un PDF, renvoie un PDF avec couche texte (OCRmyPDF).
# --skip-text : n'OCRise que les pages sans texte. Code de sortie 6 = déjà du texte.
import subprocess
import tempfile
import os
import logging
from flask import Flask, request, Response

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ocr-service")
MAX_BYTES = 25 * 1024 * 1024  # marge au-dessus de la limite Mastra (10 Mo)
MAX_ERROR_BYTES = 1200


def failure_response(message, status=500):
    safe = " ".join(str(message).split())[:MAX_ERROR_BYTES]
    logger.error("OCR failed: %s", safe)
    return Response("ocr failed", status=status, headers={"X-OCR-Error": safe})

@app.post("/ocr")
def ocr():
    data = request.get_data()
    if not data or len(data) > MAX_BYTES:
        return Response("invalid input", status=400)
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "in.pdf")
        dst = os.path.join(d, "out.pdf")
        with open(src, "wb") as f:
            f.write(data)
        try:
            proc = subprocess.run(
                ["ocrmypdf", "--skip-text", "-l", "fra",
                 # Le conteneur est limité à 1 CPU / 1 Go. Sans cette borne,
                 # OCRmyPDF déduit parfois le nombre de CPU de l'hôte et lance
                 # plusieurs workers, ce qui peut faire échouer deux ingestions
                 # concurrentes avec un 500 (OOM ou timeout).
                 "--jobs", "1", "--max-image-mpixels", "256",
                 "--output-type", "pdf", src, dst],
                capture_output=True, timeout=600,
            )
        except subprocess.TimeoutExpired:
            return failure_response("timeout after 600 seconds")
        except OSError as exc:
            return failure_response(f"cannot start ocrmypdf: {exc}")
        # 0 = OCR appliqué ; 6 = page(s) déjà avec texte -> dst quand même produit.
        # Garde : un PDF malformé peut renvoyer 6 sans produire dst -> 500 propre (pas de crash).
        if proc.returncode not in (0, 6) or not os.path.exists(dst):
            stderr = proc.stderr.decode("utf-8", errors="replace") if proc.stderr else ""
            return failure_response(
                f"ocrmypdf exit={proc.returncode}; {stderr or 'no stderr output'}",
            )
        ocr_applied = "1" if proc.returncode == 0 else "0"
        with open(dst, "rb") as f:
            out = f.read()
        return Response(out, status=200, mimetype="application/pdf",
                        headers={"X-OCR-Applied": ocr_applied})

@app.get("/health")
def health():
    return Response("ok", status=200)
