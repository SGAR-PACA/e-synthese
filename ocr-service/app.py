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
OCR_COMMON_ARGS = [
    "-l", "fra",
    # Le conteneur est limité à 1 CPU / 1 Go. Sans cette borne, OCRmyPDF déduit
    # parfois le nombre de CPU de l'hôte et lance plusieurs workers, ce qui peut
    # faire échouer deux ingestions concurrentes avec un 500 (OOM ou timeout).
    "--jobs", "1", "--max-image-mpixels", "256",
    "--output-type", "pdf",
]


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
        # Première passe conservatrice : les pages qui ont déjà une couche texte
        # sont conservées telles quelles. Si le PDF est malformé ou contient une
        # couche OCR incompatible, on tente une seconde passe contrôlée qui
        # remplace la couche invisible existante. On évite --force-ocr : il
        # rasterise tout le document et peut dégrader le PDF servi.
        attempts = [("skip-text", ["--skip-text"]), ("redo-ocr", ["--redo-ocr"])]
        errors = []
        ocr_applied = "0"
        for mode, mode_args in attempts:
            try:
                proc = subprocess.run(
                    ["ocrmypdf", *mode_args, *OCR_COMMON_ARGS, src, dst],
                    capture_output=True, timeout=600,
                )
            except subprocess.TimeoutExpired:
                errors.append(f"{mode}: timeout after 600 seconds")
                continue
            except OSError as exc:
                return failure_response(f"cannot start ocrmypdf: {exc}")

            # 0 = traitement OCR ; 6 = texte déjà présent en mode skip-text.
            # Dans les deux cas, la sortie doit exister : un PDF malformé ne doit
            # jamais être déclaré cherchable sur la seule base du code retour.
            if proc.returncode in (0, 6) and os.path.exists(dst):
                ocr_applied = "1" if proc.returncode == 0 else "0"
                break
            stderr = proc.stderr.decode("utf-8", errors="replace") if proc.stderr else ""
            errors.append(f"{mode}: exit={proc.returncode}; {stderr or 'no stderr output'}")
            # Ne pas laisser une sortie partielle empêcher la seconde passe.
            try:
                if os.path.exists(dst):
                    os.unlink(dst)
            except OSError:
                pass
        else:
            return failure_response("; ".join(errors)[:MAX_ERROR_BYTES])

        with open(dst, "rb") as f:
            out = f.read()
        return Response(out, status=200, mimetype="application/pdf",
                        headers={"X-OCR-Applied": ocr_applied})

@app.get("/health")
def health():
    return Response("ok", status=200)
