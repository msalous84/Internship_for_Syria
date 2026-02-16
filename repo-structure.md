# Repo structure (lesson progression)

```
ai-internship-chatbots/
  lessons/
    01-text-chatbot/
      backend/               # FastAPI service that calls OpenAI
      frontend/              # React UI built & served by Nginx
      docker-compose.yml      # Build/run both services
      .env.example            # Copy to .env and add your API key
      README.md
    02-image-chatbot/        # Extend Lesson 1 with image input (multimodal)
    03-voice-chatbot/        # Extend with STT/TTS + realtime voice-to-voice
    04-integration-and-models/
      integration/
      other-models/
  slides/
    lesson-01-outline.md
    lesson-02-outline.md
    lesson-03-outline.md
    lesson-04-outline.md
```
