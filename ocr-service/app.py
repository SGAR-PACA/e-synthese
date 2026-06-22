# ocr-service/app.py
# Microservice OCR : reçoit un PDF, renvoie un PDF avec couche texte (OCRmyPDF).
# --skip-text : n'OCRise que les pages sans texte. Code de sortie 6 = déjà du texte.
import subprocess
import tempfile
import os
from flask import Flask, request, Response

app = Flask(__name__)
MAX_BYTES = 25 * 1024 * 1024  # marge au-dessus de la limite Mastra (10 Mo)

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
        proc = subprocess.run(
            ["ocrmypdf", "--skip-text", "-l", "fra",
             "--max-image-mpixels", "256", "--output-type", "pdf", src, dst],
            capture_output=True, timeout=600,
        )
        # 0 = OCR appliqué ; 6 = page(s) déjà avec texte -> dst quand même produit.
        # Garde : un PDF malformé peut renvoyer 6 sans produire dst -> 500 propre (pas de crash).
        if proc.returncode not in (0, 6) or not os.path.exists(dst):
            return Response("ocr failed", status=500)
        ocr_applied = "1" if proc.returncode == 0 else "0"
        with open(dst, "rb") as f:
            out = f.read()
        return Response(out, status=200, mimetype="application/pdf",
                        headers={"X-OCR-Applied": ocr_applied})

@app.get("/health")
def health():
    return Response("ok", status=200)
