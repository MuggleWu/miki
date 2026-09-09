// API 自描述（GET /api/openapi.json）：精简 OpenAPI 3.1，供 AI agent 与脚本免读文档自发现接口。
// 只描述结构与语义，不包含 token 等敏感信息；鉴权方式见 securitySchemes。
export const openApiDoc = {
  openapi: '3.1.0',
  info: {
    title: 'Miki Local API',
    version: '0.2.0',
    description:
      'Local HTTP API of the Miki spaced-repetition app. Listens on 127.0.0.1 only; browser-originated requests (Origin/Referer) are rejected. All endpoints except GET /api/health require a bearer token from the workspace config.json (api.token).'
  },
  servers: [
    {
      url: 'http://127.0.0.1:8727/api',
      description: 'actual port may shift if occupied; see miki-api.json runtime file'
    }
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    '/health': {
      get: { summary: 'Liveness probe (no token)', responses: { 200: { description: 'ok' } } }
    },
    '/openapi.json': {
      get: { summary: 'This document', responses: { 200: { description: 'OpenAPI document' } } }
    },
    '/decks': {
      get: { summary: 'List decks with per-state card counts', responses: { 200: { description: '{decks: [...]}' } } },
      post: {
        summary: 'Create decks (one or batch)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' }, names: { type: 'array', items: { type: 'string' } } }
              }
            }
          }
        },
        responses: { 200: { description: 'created deck(s)' }, 400: { description: 'empty name' } }
      }
    },
    '/decks/{id}': {
      patch: {
        summary: 'Rename a deck',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
            }
          }
        },
        responses: { 200: { description: 'renamed deck' }, 404: { description: 'deck not found' } }
      },
      delete: { summary: 'Soft-delete a deck (its cards get hidden)', responses: { 200: { description: 'ok' } } }
    },
    '/cards': {
      get: {
        summary: 'Query cards',
        description:
          'Query params: q (multi-keyword AND, split by spaces/commas), deckId, state (new|learning|review|suspended), dueAfter/dueBefore (ms epoch), sort (e.g. updatedAt:desc,front:asc — col must be one of front/deckName/state/due/dueAbs/interval/stability/difficulty/reps/lapses/createdAt/updatedAt), limit, offset. Default limit 5000.',
        responses: {
          200: { description: '{rows: [...], total: number}' },
          400: { description: 'bad query or sort column' }
        }
      }
    },
    '/cards/get': {
      post: {
        summary: 'Fetch full cards by IDs (order preserved, missing skipped)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cardIds'],
                properties: { cardIds: { type: 'array', items: { type: 'string' } } }
              }
            }
          }
        },
        responses: { 200: { description: '{cards: [...]}' } }
      }
    },
    '/cards/{id}': {
      get: {
        summary: 'Get one card (includes soft-deleted)',
        responses: { 200: { description: 'card' }, 404: { description: 'not found' } }
      },
      patch: {
        summary: 'Partial update of card content',
        description: 'Fields left out keep their current value; a provided empty string clears that side.',
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' } } }
            }
          }
        },
        responses: {
          200: { description: 'updated card' },
          400: { description: 'no content field provided' },
          404: { description: 'not found' }
        }
      }
    },
    '/cards/add': {
      post: {
        summary: 'Add cards to a deck (single or batch)',
        description:
          'front and back must not both be empty (matches the UI rule); a batch is rejected as a whole if any item is empty.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['deckId'],
                properties: {
                  deckId: { type: 'string' },
                  front: { type: 'string' },
                  back: { type: 'string' },
                  items: {
                    type: 'array',
                    items: { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' } } }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: { description: 'card(s)' },
          400: { description: 'empty content' },
          404: { description: 'deck not found' }
        }
      }
    },
    '/cards/update': {
      post: {
        summary: 'Batch partial content update',
        description: 'items[].front/back optional — omitted fields keep their value. Returns {updated, missing}.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['cardId'],
                      properties: { cardId: { type: 'string' }, front: { type: 'string' }, back: { type: 'string' } }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          200: { description: '{updated, missing}' },
          400: { description: 'bad items or item without any content field' }
        }
      }
    },
    '/cards/move': {
      post: {
        summary: 'Move cards to another deck (keeps scheduling progress)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cardIds', 'deckId'],
                properties: { cardIds: { type: 'array', items: { type: 'string' } }, deckId: { type: 'string' } }
              }
            }
          }
        },
        responses: { 200: { description: '{moved: number}' } }
      }
    },
    '/cards/reset': {
      post: {
        summary: 'Reset cards to new (irreversible)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cardIds'],
                properties: { cardIds: { type: 'array', items: { type: 'string' } } }
              }
            }
          }
        },
        responses: { 200: { description: '{reset: number}' } }
      }
    },
    '/cards/suspend': {
      post: {
        summary: 'Suspend / unsuspend one card',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cardId', 'suspended'],
                properties: { cardId: { type: 'string' }, suspended: { type: 'boolean' } }
              }
            }
          }
        },
        responses: { 200: { description: 'card' }, 404: { description: 'not found' } }
      }
    },
    '/cards/delete': {
      post: {
        summary: 'Soft-delete cards (undoable)',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['cardIds'],
                properties: { cardIds: { type: 'array', items: { type: 'string' } } }
              }
            }
          }
        },
        responses: { 200: { description: '{deleted, missing}' } }
      }
    },
    '/stats': {
      get: {
        summary: 'Aggregated stats',
        description: 'Query params: range (year|all, default year), deckId (optional).',
        responses: { 200: { description: 'stats payload' } }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'api.token from the active workspace config.json (header x-miki-token also accepted)'
      }
    }
  }
} as const
