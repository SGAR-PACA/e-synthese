#!/usr/bin/env python3
"""Banc de test E-synthèse : rejoue les 50 questions via POST /admin/test-pipeline.

Utilise uniquement la stdlib (aucune dépendance) : lançable depuis un laptop,
le serveur, ou le terminal du conteneur mastra dans Dokploy.

Usage :
  python3 run_bench.py --base-url https://esynthese.mondomaine.fr \
      --email admin@example.fr [--password '...'] [--with-judge] [--only P01,P02] [--resume]

Le mot de passe peut aussi être fourni via la variable d'env ESY_BENCH_PASSWORD
(recommandé, évite l'historique shell). Les résultats sont écrits au fil de l'eau
dans scripts/bench/results/<horodatage>/ :
  - results.json : brut (réponse, chunks utilisés, requêtes du planner, scores juge)
  - report.md    : lisible (réponse obtenue vs attendue, sources obtenues vs attendues)

Respecte le quota Albert : questions exécutées en séquentiel, on attend la fin
d'un test avant de lancer le suivant (le limiteur global côté mastra fait le reste).
"""
import argparse
import getpass
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from http.cookiejar import CookieJar
from pathlib import Path

HERE = Path(__file__).resolve().parent
POLL_INTERVAL_S = 5
# Un test = planner + requêtes + rerank + writer (+ juge) : à 8 req/min partagées,
# 15 min de garde-fou par question restent large mais évitent un blocage infini.
TIMEOUT_PER_QUESTION_S = 15 * 60


def build_opener():
    jar = CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def api(opener, base_url, method, path, body=None, csrf=None):
    req = urllib.request.Request(base_url.rstrip("/") + path, method=method)
    req.add_header("Content-Type", "application/json")
    if csrf:
        req.add_header("x-csrf-token", csrf)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with opener.open(req, data=data, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode() or "null")
        except Exception:
            payload = None
        return e.code, payload


def sanitize(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True, help="URL du front, ex: https://esynthese.mondomaine.fr (l'API admin mastra est derrière /admin)")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", default=os.environ.get("ESY_BENCH_PASSWORD") or None)
    ap.add_argument("--with-judge", action="store_true", help="Ajoute la notation LLM-juge (+1 appel Albert/question)")
    ap.add_argument("--only", default=None, help="Liste d'ids séparés par des virgules, ex: P01,P02,G40")
    ap.add_argument("--questions", default=str(HERE / "questions.json"))
    ap.add_argument("--out-dir", default=None, help="Répertoire de sortie (défaut: results/<horodatage>). Avec --resume, reprend les questions non encore traitées de ce répertoire.")
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    password = args.password or getpass.getpass("Mot de passe admin mastra : ")
    questions = json.loads(Path(args.questions).read_text(encoding="utf-8"))
    if args.only:
        wanted = {x.strip() for x in args.only.split(",")}
        questions = [q for q in questions if q["id"] in wanted]
    if not questions:
        sys.exit("Aucune question sélectionnée.")

    out_dir = Path(args.out_dir) if args.out_dir else HERE / "results" / datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    results_path = out_dir / "results.json"
    results = {}
    if args.resume and results_path.exists():
        results = json.loads(results_path.read_text(encoding="utf-8"))
        print(f"Reprise : {len(results)} résultats déjà présents dans {out_dir}")

    opener = build_opener()
    status, payload = api(opener, args.base_url, "POST", "/admin/login",
                          {"email": args.email, "password": password})
    if status != 200 or not payload or not payload.get("csrfToken"):
        sys.exit(f"Échec du login ({status}): {payload}")
    csrf = payload["csrfToken"]
    print(f"Connecté ({payload.get('role', '?')}). {len(questions)} question(s) à traiter, juge={'oui' if args.with_judge else 'non'}.")

    for i, q in enumerate(questions, 1):
        if q["id"] in results and results[q["id"]].get("status") == "completed":
            continue
        print(f"[{i}/{len(questions)}] {q['id']} … ", end="", flush=True)
        status, run = api(opener, args.base_url, "POST", "/admin/test-pipeline",
                          {"query": q["question"], "withJudge": args.with_judge}, csrf=csrf)
        if status != 202 or not run or "id" not in run:
            print(f"échec du lancement ({status}): {run}")
            results[q["id"]] = {"status": "launch_failed", "http": status, "payload": run}
            results_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
            continue

        deadline = time.time() + TIMEOUT_PER_QUESTION_S
        final = None
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL_S)
            status, tr = api(opener, args.base_url, "GET", f"/admin/test-pipeline/{run['id']}")
            if status == 200 and tr and tr.get("status") in ("completed", "failed"):
                final = tr
                break
        if final is None:
            print("timeout")
            results[q["id"]] = {"status": "timeout", "test_id": run["id"]}
        else:
            res = final.get("result") or {}
            got_sources = sorted({c.get("name", "?") for c in res.get("usedChunks", [])})
            results[q["id"]] = {
                "status": final["status"],
                "test_id": run["id"],
                "error": final.get("error"),
                "answer": res.get("answer"),
                "plan": res.get("plan"),
                "used_sources": got_sources,
                "scores": res.get("scores"),
                "expected_answer": q["reponse_attendue"],
                "expected_sources": q["sources_attendues"],
                "question": q["question"],
            }
            print(final["status"], f"(sources: {', '.join(got_sources) or 'aucune'})")
        results_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    # Rapport lisible
    lines = [f"# Bench E-synthèse — {datetime.now():%d/%m/%Y %H:%M}", ""]
    ok_src = 0
    done = 0
    for q in questions:
        r = results.get(q["id"])
        if not r:
            continue
        lines.append(f"## {q['id']}")
        lines.append(f"**Question :** {q['question']}")
        if r.get("status") != "completed":
            lines.append(f"**Statut :** {r.get('status')} — {r.get('error') or ''}")
            lines.append("")
            continue
        done += 1
        expected_set = {s for s in r["expected_sources"]}
        got_set = set(r.get("used_sources") or [])
        src_match = expected_set.issubset(got_set)
        ok_src += src_match
        lines.append(f"**Réponse obtenue :** {r.get('answer') or '(vide)'}")
        lines.append(f"**Réponse attendue :** {r['expected_answer']}")
        lines.append(f"**Sources obtenues :** {', '.join(sorted(got_set)) or 'aucune'}")
        lines.append(f"**Sources attendues :** {', '.join(sorted(expected_set))} — {'OK' if src_match else 'MANQUANTES'}")
        if r.get("scores"):
            lines.append(f"**Scores juge :** {json.dumps(r['scores'], ensure_ascii=False)}")
        lines.append("")
    lines.insert(1, f"{done} question(s) terminée(s) ; sources attendues toutes présentes : {ok_src}/{done}")
    (out_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"\nTerminé. Résultats : {results_path}\nRapport : {out_dir / 'report.md'}")


if __name__ == "__main__":
    main()
