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

## Unified context & continuous conversations

- **Message buses** — Conversations flow through channels: `root` (desktop chat), `telegram-{peer_id}` (Telegram chats). Each bus has its own history.
- **Unified root context** — All messages from every bus are merged into a single chronological log. The agent always sees the full picture: desktop, Telegram, everything. Trimmed to 50K chars; use `get_bus_history` for more.
- **Persistent history** — Stored in the Knowledge Base at `kb/history/{mb_id}/{date}/{seq}.md`. Conversations survive restarts. No amnesia.
- **Multiple social connections** — Talk via desktop popup, Telegram DMs, or both. The agent knows who said what and where. Trust levels (`root` vs `normal`) control which buses get task progress and assessments.

---

## History system

All message bus data lives in the KB:

- **History**: `kb/history/{mb_id}/{date}/{seq}.md` — YAML frontmatter + content per message
- **Properties**: `kb/history/{mb_id}/properties.md` — Bus metadata (description, trust_level, is_banned)

Root is a virtual merge of all buses. No separate `yaaia/mb` — everything is in KB. Run `npm run migrate:history` once when upgrading from older formats.

---

## Telegram

- **Connect** — `telegram_connect` with your phone. The agent logs in as you (user account, not bot). Returns bus listings.
- **Search** — `telegram_search` resolves @username to bus_id. Message anyone by handle.
- **Missed messages** — On connect, fetches messages received while the app was closed. Appended to history with correct timestamps.
- **Delete bus** — Removes the chat from Telegram too (via mtcute). Requires Telegram connected.

---

## Scheduled tasks

- **Startup task** — Runs when the app starts. Configurable title + instructions. If scheduled tasks were due while the app was closed, they’re included in the startup prompt.
- **One-time tasks** — `schedule_task` (at, title, instructions). At the scheduled time, the task is injected at root. `delete_scheduled_task` cancels by id.

---

## The vibe

- **Assessment & clarification** — Every tool call asks the agent: "What do you think happened?" and "Why are you doing this?" No silent button-mashing. It has to explain itself.
- **send_message(wait_for_answer=true)** — When it needs input, it sends a message and waits for your reply. You have 60 seconds. Then it's on its own.
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

**Upgrading from an older version?** Run `npm run migrate:history` once to migrate your history and message buses to the new KB format.

---

## Tech stack

- Electron + Vue
- Chrome DevTools MCP (chrome-devtools-mcp)
- Claude API / OpenRouter
- IMAP (imapflow)
- Telegram (mtcute)
- QMD (Knowledge Base search)

---

*YAAIA — because sometimes the best agent is the one you built yourself.*
