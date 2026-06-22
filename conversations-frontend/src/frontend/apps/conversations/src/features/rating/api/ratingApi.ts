import { getRatingToken } from '@/features/rating/auth/keycloak';

const RATING_API_URL = process.env.NEXT_PUBLIC_RATING_API_URL;

export interface SubmitRatingParams {
  messageId: string;
  conversationId: string;
  rating: number;
  comment: string;
  question: string;
  answer: string;
}

function baseUrl(): string | null {
  return RATING_API_URL ? RATING_API_URL.replace(/\/$/, '') : null;
}

// Envoie (ou met à jour) la note de l'utilisateur pour un message.
export async function submitRating(params: SubmitRatingParams): Promise<void> {
  const url = baseUrl();
  if (!url) {
    throw new Error('Notation non configurée (NEXT_PUBLIC_RATING_API_URL).');
  }
  const token = await getRatingToken();
  if (!token) {
    throw new Error('Session de notation indisponible.');
  }
  // Borne la note à un entier valide 1–5 pour éviter toute valeur hors plage côté API.
  const rating = Math.min(5, Math.max(1, Math.round(params.rating)));
  const res = await fetch(`${url}/v1/ratings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message_id: params.messageId,
      conversation_id: params.conversationId,
      rating: rating,
      comment: params.comment,
      question: params.question,
      answer: params.answer,
    }),
  });
  if (!res.ok) {
    throw new Error(`Échec de l'envoi de la note (${res.status}).`);
  }
}

// Récupère la note existante de l'utilisateur pour un message (ou null).
export async function getRating(
  messageId: string,
): Promise<{ rating: number; comment: string } | null> {
  const url = baseUrl();
  if (!url) {
    return null;
  }
  const token = await getRatingToken();
  if (!token) {
    return null;
  }
  const res = await fetch(
    `${url}/v1/ratings?message_id=${encodeURIComponent(messageId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { rating: number; comment: string } | null;
  return data && typeof data.rating === 'number' ? data : null;
}
