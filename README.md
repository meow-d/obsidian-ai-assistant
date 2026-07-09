# Wikilink-Aware AI Assistant for Obsidian
![](https://raw.githubusercontent.com/meow-d/obsidian-ai-assistant/refs/heads/main/src/assets/screenshot_smartsuggestions.webp)

As PKM knowledge bases grow, users struggle to maintain connections between notes and rediscover relevant information. Existing AI features address this poorly, focusing on content generation rather than supporting the synthesis and linking processes that make note-taking valuable. This AI assistant plugin aims to assist the users' workflows while preserving those processes.

Made as part of my degree final year project.

## features
| feature | description | technology | location |
|---------|-------------|------|------|
| ai agent | ai agent with access to the vault's knowledge graph. it can edit notes as well. | LLM, embeddings | sidebar |
| quote-in-chat | highlight text in your notes, then quote it directly into the agent chat without manually copying. | LLM | right-click menu |
| natural language search | search notes using natural language queries instead of exact keywords (e.g., "meeting notes about improving team productivity"). | embeddings | sidebar |
| orphan note rescuer | lists notes with no outgoing links and suggests similar notes to help you make connections. | embeddings | sidebar |
| wikilink suggestions | detects phrases in your current note that match or relate to other notes, and suggests wikilinks to create. | embeddings, nlp | editor suggestion |
| similar notes | recommends semantically related notes as you work. | embeddings | sidebar |
| tag suggestions | suggests relevant existing tags based on your note's content. | embeddings, nlp | text editor |
| folder suggestions | suggests which existing folder a note belongs in. | embeddings, nlp | sidebar |
| note split suggestions | detects when a note covers multiple distinct topics and suggests splitting it into separate notes. | embeddings, nlp | sidebar |
| resurfacing forgotten notes | surfaces notes semantically similar to your current work that you haven't visited in a while. | embeddings, nlp, recency | sidebar |
| custom LLM providers | bring your own api key and choose from multiple LLM providers (claude, deepseek, etc). | LLM | settings |
| fine-tuned embedding model (WIP) | embedding model that's fine-tuned on obsidian notes and this plugin's functionality | embeddings | implementation detail |

## privacy
- LLM features (like AI agent) sends data to your configured LLM provider. Privacy concious users can configure it to be local
- embeddings are entirely local

## development
```bash
pnpm install
pnpm dev        # development mode with hot reload
pnpm build      # production build
pnpm test       # run tests
```

## license
MIT
