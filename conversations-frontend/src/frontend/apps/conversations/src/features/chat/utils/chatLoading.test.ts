import type { Message } from '@ai-sdk/ui-utils';

import { isAwaitingFirstAssistantOutput } from './chatLoading';

const user = (content = 'Question'): Message => ({
  id: 'user-1',
  role: 'user',
  content,
});

const assistant = (content = '', parts?: Message['parts']): Message => ({
  id: 'assistant-1',
  role: 'assistant',
  content,
  parts,
});

describe('isAwaitingFirstAssistantOutput', () => {
  it.each(['submitted', 'streaming'] as const)(
    'reste visible en statut %s avant la création du message assistant',
    (status) => {
      expect(isAwaitingFirstAssistantOutput([user()], status)).toBe(true);
    },
  );

  it('reste visible quand le stream est ouvert mais le message assistant est vide', () => {
    expect(
      isAwaitingFirstAssistantOutput([user(), assistant()], 'streaming'),
    ).toBe(true);
  });

  it('ignore une ancienne réponse située avant la dernière question', () => {
    expect(
      isAwaitingFirstAssistantOutput(
        [user('Ancienne question'), assistant('Ancienne réponse'), user()],
        'streaming',
      ),
    ).toBe(true);
  });

  it('disparaît dès le premier texte de la nouvelle réponse', () => {
    expect(
      isAwaitingFirstAssistantOutput(
        [user(), assistant('Premier token')],
        'streaming',
      ),
    ).toBe(false);
  });

  it('disparaît lorsqu’un outil visible prend le relais', () => {
    expect(
      isAwaitingFirstAssistantOutput(
        [
          user(),
          assistant('', [
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'call',
                toolCallId: 'tool-1',
                toolName: 'search',
                args: {},
              },
            },
          ]),
        ],
        'streaming',
      ),
    ).toBe(false);
  });

  it('reste visible si le stream ne contient encore qu’une source masquée', () => {
    expect(
      isAwaitingFirstAssistantOutput(
        [
          user(),
          assistant('', [
            {
              type: 'source',
              source: {
                sourceType: 'url',
                id: 'source-1',
                url: 'https://example.test/source',
              },
            },
          ]),
        ],
        'streaming',
      ),
    ).toBe(true);
  });

  it.each(['ready', 'error'] as const)(
    'n’affiche rien lorsque le statut est %s',
    (status) => {
      expect(isAwaitingFirstAssistantOutput([user()], status)).toBe(false);
    },
  );
});
