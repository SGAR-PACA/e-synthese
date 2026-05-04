{
  "models": [
    {
      "hrid": "default-model",
      "model_name": "e-synthese-rag",
      "human_readable_name": "E-Synthèse RAG (Mastra)",
      "provider_name": "mastra",
      "profile": null,
      "settings": {},
      "is_active": true,
      "icon": null,
      "system_prompt": "Tu es E-Synthèse, l'assistant IA de l'Assemblée nationale, avec accès à une base documentaire via RAG.",
      "tools": []
    },
    {
      "hrid": "demo-model",
      "model_name": "demo",
      "human_readable_name": "Demo (placeholder)",
      "provider_name": "mastra",
      "profile": null,
      "settings": {},
      "is_active": true,
      "icon": null,
      "system_prompt": "Tu es un assistant de démonstration.",
      "tools": []
    },
    {
      "hrid": "default-summarization-model",
      "model_name": "e-synthese-rag",
      "human_readable_name": "E-Synthèse Summarization",
      "provider_name": "mastra",
      "profile": null,
      "settings": {},
      "is_active": true,
      "icon": null,
      "system_prompt": "Tu résumes une conversation en une phrase courte pour en faire le titre.",
      "tools": []
    }
  ],
  "providers": [
    {
      "hrid": "mastra",
      "base_url": "http://mastra:4111/v1",
      "api_key": "${PROXY_API_KEY}",
      "kind": "openai",
      "co2_handling": null
    }
  ]
}
