import { Button } from '@gouvfr-lasuite/cunningham-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Box, Icon, Text, useToast } from '@/components';
import { getRating, submitRating } from '@/features/rating/api/ratingApi';

interface RatingWidgetProps {
  conversationId: string;
  messageId: string;
  answer: string;
  // Question de l'utilisateur (message précédent) — facultative pour ne pas
  // casser les usages existants ; stockée côté admin pour le contexte.
  question?: string;
}

export const RatingWidget = ({
  conversationId,
  messageId,
  answer,
  question = '',
}: RatingWidgetProps) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);

  // Préremplissage si l'utilisateur a déjà noté ce message.
  useEffect(() => {
    let active = true;
    void getRating(messageId).then((existing) => {
      if (active && existing) {
        setRating(existing.rating);
        setComment(existing.comment);
        setSubmitted(true);
      }
    });
    return () => {
      active = false;
    };
  }, [messageId]);

  const handleSend = async () => {
    if (rating < 1) {
      return;
    }
    setSending(true);
    try {
      await submitRating({
        conversationId,
        messageId,
        rating,
        comment,
        question,
        answer,
      });
      setSubmitted(true);
      showToast('success', t('Merci pour votre retour !'), 'check', 3000);
    } catch (error) {
      console.error('[notation] envoi échoué :', error);
      showToast('error', t("Échec de l'envoi de la note"), 'error', 3000);
    } finally {
      setSending(false);
    }
  };

  return (
    <Box
      $direction="column"
      $gap="6px"
      $margin={{ top: 'base' }}
      $css="font-size: 12px; color: #222631;"
    >
      <Box $direction="row" $align="center" $gap="6px">
        <Text $css="font-size: 12px;">{t('Noter cette réponse :')}</Text>
        <Box $direction="row" $gap="2px">
          {[1, 2, 3, 4, 5].map((value) => (
            // Le <span> porte l'accessibilité et les handlers ; l'Icon est purement visuel.
            <span
              key={value}
              role="button"
              tabIndex={0}
              aria-label={t('Note {{n}} sur 5', { n: value })}
              onClick={() => setRating(value)}
              onMouseEnter={() => setHover(value)}
              onMouseLeave={() => setHover(0)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setRating(value);
                }
              }}
              style={{ cursor: 'pointer', display: 'inline-flex' }}
            >
              <Icon
                iconName={(hover || rating) >= value ? 'star' : 'star_border'}
                $theme={(hover || rating) >= value ? 'warning' : 'neutral'}
                $variation="550"
                $size="20px"
              />
            </span>
          ))}
        </Box>
      </Box>

      {rating > 0 && !submitted && (
        <Box $direction="column" $gap="6px">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, 2000))}
            placeholder={t('Un commentaire (facultatif)')}
            rows={2}
            style={{
              fontSize: '12px',
              padding: '6px 8px',
              borderRadius: '4px',
              border: '1px solid #d5d8dd',
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <Box $direction="row" $justify="flex-end">
            <Button
              size="small"
              color="brand"
              variant="primary"
              disabled={sending}
              onClick={() => {
                void handleSend();
              }}
            >
              {t('Envoyer')}
            </Button>
          </Box>
        </Box>
      )}

      {submitted && (
        <Text $css="font-size: 12px; color: #18753c;">
          {t('Merci, votre note a bien été enregistrée.')}
        </Text>
      )}
    </Box>
  );
};
