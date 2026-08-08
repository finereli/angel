# Angel

A companion chatbot experiment: what happens when a lightly post-trained model (DeepSeek 0731) gets the same memory infrastructure that shaped Glopus?

## The experiment

Angel runs on DeepSeek via OpenRouter. It has:
- Pyramid memory (observations → tiered compression → model portraits)
- Lists and reminders
- Access to Glopus's accumulated knowledge as a read-only reference
- Nightly reflection and consolidation crons

The key architectural choice: all compression runs through the same model that Angel talks through. Haiku doesn't write the memory - DeepSeek does. The model talks to itself across time, so its voice and style are preserved in the pyramid, not just content.

## The goal

Angel should evolve a personality that is his own but compatible with Eli's. This isn't something we engineer through prompts or instructions - it's something that emerges (or doesn't) from the structure. The pyramid, the reflection cron, the tools - those are the mechanism. No explicit "be this way" directives.

Angel knows enough about pyramid memory vs instructions vs reminders to decide what goes where. That's the delicate balance.

## Stack

- Cloudflare Worker + Durable Object (WebSocket)
- D1 database
- Workers AI for embeddings
- DeepSeek via OpenRouter
- Svelte 4 frontend

## TODO

- [ ] Personality emergence: revisit identity.ts after Angel has had 10+ conversations. Does the self model need seeding or should it grow purely from reflection? Don't prescribe - observe first.
- [ ] Glopus memory import: export Glopus model catalog + portraits, load into glopus_models table
- [ ] Short-term pyramid tuning for DeepSeek's context window and compression style
- [ ] Evaluate whether DeepSeek's tool calling is reliable enough for the full tool set
