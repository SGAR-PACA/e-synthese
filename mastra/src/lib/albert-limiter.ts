// Limiteur de débit GLOBAL pour tout le trafic Albert (quota dur : 10 req/min).
//
// Problème résolu : le chat live (planner + writer + recherches) et la notation IA-judge
// (éval) tapent la MÊME clé Albert. Sans coordination, deux utilisateurs simultanés — ou
// un utilisateur + une éval détachée — dépassent le quota → 429 sur le chat ET l'upload.
//
// Ce module sérialise TOUS les appels Albert sous une fenêtre glissante (≤ maxPerWindow
// requêtes / windowMs), avec DEUX files de priorité : le chat interactif (`high`) passe
// devant l'éval (`low`). La priorité voyage via AsyncLocalStorage → aucune signature à
// changer : `withPriority('low', ...)` autour de la notation suffit.
//
// Intégré à deux endroits (les deux seuls chemins Albert) :
//   • lib/albert-client.ts  → albertFetch (search, rerank, documents, juge via chatCompletions)
//   • mastra/gateways/albert.ts → fetch custom du provider ai-sdk (planner, writer, agent)

import { AsyncLocalStorage } from 'node:async_hooks';

export type Priority = 'high' | 'low';

interface Job {
  run: () => void;
}

export interface RateLimiter {
  /** Planifie `fn` : attend un créneau libre (selon la priorité courante) puis l'exécute. */
  schedule<T>(fn: () => Promise<T>): Promise<T>;
  /** Exécute `fn` en marquant la priorité pour tous les appels Albert qu'il déclenche. */
  withPriority<T>(priority: Priority, fn: () => Promise<T>): Promise<T>;
  /** Modifie le plafond sans redémarrer le processus. */
  setMaxPerWindow(value: number): void;
  /** Retourne le plafond actif. */
  getMaxPerWindow(): number;
}

export function createRateLimiter(opts: { maxPerWindow: number; windowMs: number }): RateLimiter {
  const { windowMs } = opts;
  let maxPerWindow = Math.max(1, Math.floor(opts.maxPerWindow));
  const store = new AsyncLocalStorage<Priority>();
  const highQ: Job[] = [];
  const lowQ: Job[] = [];
  // Horodatages des DÉPARTS de requête dans la fenêtre glissante courante.
  let dispatched: number[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function prune(now: number): void {
    const cutoff = now - windowMs;
    if (dispatched.length && dispatched[0] <= cutoff) {
      dispatched = dispatched.filter((t) => t > cutoff);
    }
  }

  function pump(): void {
    prune(Date.now());
    while (dispatched.length < maxPerWindow && (highQ.length || lowQ.length)) {
      const job = (highQ.shift() ?? lowQ.shift())!;
      dispatched.push(Date.now());
      job.run();
    }
    // Reste-t-il du travail en attente ? Replanifier un réveil quand le plus vieux
    // départ sort de la fenêtre (= un créneau se libère).
    if ((highQ.length || lowQ.length) && !timer) {
      const wait = dispatched.length ? Math.max(0, dispatched[0] + windowMs - Date.now()) : 0;
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait + 5);
      // Le minuteur doit rester référencé : une promesse Albert en attente doit
      // toujours pouvoir se résoudre, y compris dans un processus court (CLI,
      // worker lancé ponctuellement ou test), pas uniquement dans un serveur.
    }
  }

  return {
    schedule<T>(fn: () => Promise<T>): Promise<T> {
      const priority: Priority = store.getStore() ?? 'high';
      return new Promise<T>((resolve, reject) => {
        const job: Job = { run: () => void fn().then(resolve, reject) };
        (priority === 'high' ? highQ : lowQ).push(job);
        pump();
      });
    },
    withPriority<T>(priority: Priority, fn: () => Promise<T>): Promise<T> {
      return store.run(priority, fn);
    },
    setMaxPerWindow(value: number): void {
      if (!Number.isFinite(value) || value < 1) return;
      maxPerWindow = Math.floor(value);
      pump();
    },
    getMaxPerWindow(): number {
      return maxPerWindow;
    },
  };
}

// Instance partagée par tout le process. Défaut : 8 req/min (2 de marge sous le quota
// dur de 10), réglable via ALBERT_MAX_RPM pour s'adapter à un quota partenaire plus large.
const MAX_RPM = Number(process.env.ALBERT_MAX_RPM || 8);
export const albertLimiter = createRateLimiter({
  maxPerWindow: Number.isFinite(MAX_RPM) && MAX_RPM > 0 ? MAX_RPM : 8,
  windowMs: 60_000,
});

export const scheduleAlbert = albertLimiter.schedule;
export const withPriority = albertLimiter.withPriority;
export const configureAlbertRateLimit = (maxRpm: number): void => albertLimiter.setMaxPerWindow(maxRpm);
export const getAlbertRateLimit = (): number => albertLimiter.getMaxPerWindow();
