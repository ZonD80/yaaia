# YAAIA

Python console client for Telegram, Google Workspace, and AI-routed root chat.

This rewrite removes the Electron UI, Node runtime, VM control, and memory layer. Current scope is:

- Telegram text chat through `python-telegram` / TDLib.
- Optional Telegram voice calls through `py-tgcalls` / `ntgcalls`.
- Gmail and Google Calendar polling through `google-api-python-client`.
- A terminal TUI that prints all stored and incoming messages.
- Local SQLite history under `~/yaaia/data/messages.sqlite3` by default.

## Setup

1. Copy `.env.example` to `.env` and fill in credentials.
2. Put Google OAuth desktop credentials at `~/yaaia/google/credentials.json`, or set `YAAIA_GOOGLE_CREDENTIALS`.
3. Run `./scripts/setup-conda.sh`.
4. Start the console with `./launch.sh`.

The setup script creates a local conda env in `.conda` using the same Python major/minor version as the Python executable running this agent environment.

You can also run the interactive credential setup:

```sh
python -m yaaia setup
```

If `secrets.txt` exists locally, import available Telegram and Google OAuth values without prompting:

```sh
python -m yaaia setup --from-secrets
```

## Telegram

Create Telegram API credentials at `https://my.telegram.org/apps`, then set:

```sh
YAAIA_TELEGRAM_API_ID=123456
YAAIA_TELEGRAM_API_HASH=...
YAAIA_TELEGRAM_PHONE=+1234567890
```

Bot token login is also supported with `YAAIA_TELEGRAM_BOT_TOKEN`.

On Apple Silicon, `python-telegram` may install an x86_64 bundled TDLib, while Homebrew's stable `tdlib` bottle can be too old for current Telegram login. Build the current TDLib JSON library directly from `tdlib/td`:

```sh
./scripts/install-tdlib.sh
```

The script installs `~/yaaia/tdlib/libtdjson.dylib` and updates `YAAIA_TDLIB_LIBRARY_PATH` in `.env`.

## Telegram Calls

Voice calls are optional because they require a second MTProto/media stack. Speech uses native macOS components: SpeechAnalyzer/DictationTranscriber for STT and NSSpeechSynthesizer for TTS.

```sh
pip install -r requirements-voice.txt
```

Set `YAAIA_CALLS_ENABLED=1`, then start YAAIA. The call service uses a separate Pyrogram session under `~/yaaia/telegram/calls` by default. On first start Pyrogram may ask for Telegram login code.

When calls are enabled, YAAIA builds a small Swift helper into `~/yaaia/voice/helpers` and checks that the configured SpeechAnalyzer locale is available. The helper embeds macOS Speech Recognition usage text, so the first `voice check` may trigger a system permission prompt. SpeechAnalyzer may install Apple speech assets the first time a locale is used. Use `YAAIA_SPEECH_LOCALE=en-US` to choose the transcription locale and `YAAIA_SPEECH_PREFLIGHT_ENABLED=0` to skip the startup check.

TTS uses NSSpeechSynthesizer in the native helper. Set `YAAIA_MACOS_TTS_VOICE` to a system voice name or voice identifier, or leave it empty for the default voice. `YAAIA_MACOS_TTS_RATE=210` controls speed. Spoken call replies are still split into short chunks with `YAAIA_CALLS_TTS_CHUNK_CHARS` and `YAAIA_CALLS_TTS_MAX_CHUNKS`; long details go through Telegram text fallback.

For call transcription, YAAIA keeps a short pre-roll before detected speech, pads the utterance, converts it to normalized 16 kHz mono WAV, and sends that file to SpeechAnalyzer. macOS 26 or newer and `swiftc` are required.

Call commands:

```sh
call status
voice check
calls start
call start telegram-123456789
call accept telegram-123456789
call say telegram-123456789 Hello from YAAIA
call hangup telegram-123456789
voice tts Hello
voice stt /path/to/audio.wav
```

During an active call, incoming speech is recorded from Telegram media frames, transcribed with SpeechAnalyzer, appended to the same `telegram-<chat_id>` bus, and routed through the agent. Agent replies to that Telegram bus are synthesized with native macOS TTS and sent back into the call as PCM frames. `YAAIA_CALLS_TEXT_FALLBACK=1` also sends the same reply as Telegram text.

## Google

Run `google auth` inside the TUI once. The OAuth token is saved to `~/yaaia/google/token.json`.
This command opens a browser consent flow and also prints the authorization URL as a fallback.

## AI Agent

YAAIA imports the old Electron config from `~/yaaia/appData/config.json` when present. Configure or repair it with:

```sh
python -m yaaia setup
```

Inside the TUI, use `agent setup`, `agent status`, and `agent reset`. Supported chat providers are OpenRouter, Claude, and restored Codex auth from `~/yaaia/codex-auth.json`.

When the model needs local computation it can write `[yaaia=python]...[/yaaia]` blocks. The TUI displays the script, executes it with the same Python interpreter as YAAIA, shows stdout/stderr, and feeds the result back to the model for the final bus-prefixed reply.

The agent can send Gmail through bus routing. Use `email:<to> | <subject> | <body>` for a new message, or `gmail-<bus_id>:<body>` to reply to the latest inbound email on that Gmail bus. Header form is also supported for `to`, `cc`, `bcc`, `subject`, `html`, and `attachments`.

Schedules live in `~/yaaia/schedules.json`. Due schedules are injected into the root bus and handled by the agent; missed schedules are also included in the startup command. The agent can manage schedules with Python helpers such as `schedule_create(...)`, `schedules_list()`, `schedule_update(...)`, and `schedule_delete(...)`.

Telegram search is available through `telegram search <query>` in the TUI and `telegram_search(query)` / `telegram_resolve(target)` in agent Python blocks. Results include `telegram-<chat_id>` bus ids, and `telegram-@username:<message>` routes are resolved before sending.

The Python rewrite restores the old app's addressbook and secrets stores. Contacts live in the SQLite database and are migrated from `~/yaaia/storage/history.db` when present. Secrets use the old-compatible `~/yaaia/passwords.json` format and support `string` and `totp` entries.

Bus forgetting is persistent. `forget bus <bus_id>` deletes local messages for that bus, deletes its root mirrors, removes the bus from contacts, and hides future live events until `restore bus <bus_id>` is run.

## TUI Commands

- `<message>` appends a message to the root bus.
- `status`
- `agent status`
- `agent setup`
- `agent reset`
- `clear chat`
- `call status`
- `voice check`
- `calls start`
- `call start <telegram-bus|chat_id>`
- `call accept <telegram-bus|chat_id>`
- `call hangup [telegram-bus|chat_id]`
- `call say <telegram-bus|chat_id> <text>`
- `voice tts <text>`
- `voice stt <path>`
- `contacts`
- `contacts search <query>`
- `contact get <id|identifier>`
- `contact add <name> | <identifier> | [trust] | [buses] | [notes]`
- `contact update <id|identifier> field=value ...`
- `contact delete <id|identifier>`
- `secrets`
- `secret get <id|description> [raw]`
- `secret set <description> | <string|totp> | <value> [| force]`
- `secret delete <id|description>`
- `buses`
- `connected buses`
- `forget bus <bus_id>`
- `restore bus <bus_id>`
- `forgotten buses`
- `history [limit]`
- `history all [limit]`
- `schedules`
- `schedule add <at> | <title> | <instructions> [| repeat]`
- `schedule update <id> field=value ...`
- `schedule delete <id>`
- `schedule run due`
- `startup`
- `startup run`
- `startup set <title> | <instructions>`
- `telegram chats [limit]`
- `telegram search <query>`
- `telegram resolve <username|chat_id>`
- `telegram send <chat_id|@username> <message>`
- `google auth`
- `google poll`
- `gmail send <to> <subject> | <body>`
- `quit`
