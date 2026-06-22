export interface RatingInput {
  message_id: string;
  conversation_id: string;
  rating: number;
  comment: string;
  question: string;
  answer: string;
}

function str(v: any, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function validateRatingInput(body: any): { ok: true; value: RatingInput } | { ok: false } {
  if (!body || typeof body !== 'object') return { ok: false };
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false };
  const message_id = str(body.message_id, 200);
  if (!message_id) return { ok: false };
  return {
    ok: true,
    value: {
      message_id,
      conversation_id: str(body.conversation_id, 200),
      rating,
      comment: str(body.comment, 2000),
      question: str(body.question, 8000),
      answer: str(body.answer, 8000),
    },
  };
}
