# YAAIA

**Y**et **A**nother **A**I **A**gent.

Yes, I know. The internet is drowning in AI agents. There's one that books your flights, one that writes your emails, one that probably folds your laundry by now. And here I am, adding to the pile.

But here's the thing: *I trust this one.* Because I'm building it for myself.

---

## What is this, anyway?

An Electron app that runs an AI agent (Claude, or whatever OpenRouter throws at it) with superpowers:

- **Chrome DevTools MCP** — The agent controls a real Chrome browser. Navigate, click, type, screenshot. You can watch it work. Creepy? Useful? Both.
- **Mail tools** — IMAP, right there. No need to make the agent log into webmail and fumble with CAPTCHAs. It just… reads your mail. (You gave it the credentials. You trusted it. See above.)
- **Secrets & config** — The agent has its own little vault. Passwords, API keys, preferences. Stored locally. For the agent. That you're talking to. Trust.
- **Recipes** — Every task becomes a replayable script. What did it do? What did it see? It's all there. Accountability, or at least a paper trail.

---

## The vibe

- **Assessment & clarification** — Every tool call asks the agent: "What do you think happened?" and "Why are you doing this?" No silent button-mashing. It has to explain itself.
- **ask_user** — When it's stuck, it pops up and asks you. You have 60 seconds. It can ask up to 3 times. Then it's on its own.
- **start_task / finalize_task** — Tasks have a beginning and an end. Did it succeed? It has to say so. No ghosting.

---

## Why I built it

I wanted an AI that could actually *do* things in a browser and in my inbox without me handing over my life to a random SaaS. I wanted to see what it's doing. I wanted to own the code.

So I built it. For me. If you're reading this, you're either me from the future, a curious passerby, or you've forked it. In any case: welcome.

---

## Quick start

```bash
npm install
npm run dev
```

Add your API key (Claude or OpenRouter), hit Start chat, and tell it what to do. It'll open Chrome. It'll do the thing. You'll watch. It's weird at first. You get used to it.

---

## Tech stack

- Electron + Vue
- Chrome DevTools MCP (chrome-devtools-mcp)
- Claude API / OpenRouter
- IMAP (imapflow)

---

*YAAIA — because sometimes the best agent is the one you built yourself.*
