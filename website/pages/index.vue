<template>
  <div>
    <main>
      <section
        class="mx-auto max-w-6xl px-4 pb-12 pt-12 sm:px-6 sm:pb-16 sm:pt-16 lg:px-8 lg:pb-20 lg:pt-20"
      >
        <div class="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div class="max-w-xl">
            <p
              class="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500"
            >
              Yet Another Artifical Intelligence Agent
            </p>
            <h1
              class="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
            >
              I’m building an agent I actually trust
            </h1>
            <p class="mt-6 text-pretty text-lg leading-relaxed text-neutral-600 sm:text-xl">
              The internet is full of AI agents by now. I’m still adding to the pile — but
              this one is different for me: I’m making it for myself first. When it’s ready,
              I’ll happily point other people at it too.
            </p>
            <p class="mt-4 text-pretty text-base leading-relaxed text-neutral-500 sm:text-lg">
              Below is how it actually works in the app today — not a marketing wish list.
            </p>
            <div class="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                href="#why"
                class="inline-flex items-center justify-center rounded-xl bg-neutral-900 px-6 py-3 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-neutral-800"
              >
                Why I’m doing this
              </a>
              <a
                href="#wake"
                class="inline-flex items-center justify-center rounded-xl border border-neutral-300 px-6 py-3 text-center text-sm font-semibold text-neutral-900 transition hover:bg-neutral-50"
              >
                How it behaves
              </a>
            </div>
          </div>
          <div class="relative flex justify-center lg:justify-end">
            <div
              class="relative aspect-square w-full max-w-md rounded-3xl border border-neutral-200 bg-neutral-50 p-10 shadow-[0_24px_80px_-24px_rgba(0,0,0,0.15)]"
            >
              <img
                src="/icon.png"
                alt=""
                class="h-full w-full object-contain"
                width="320"
                height="320"
              />
            </div>
          </div>
        </div>
      </section>

      <section
        id="why"
        class="border-t border-neutral-200 bg-neutral-50/80 py-14 sm:py-20"
      >
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">
            Personal first, public when it makes sense
          </h2>
          <p class="mt-4 text-lg leading-relaxed text-neutral-600">
            I want something I can rely on day to day — not a demo that looks good in a
            keynote. That means dogfooding it, breaking it, and fixing it until it feels
            boring in a good way. The project is GPLv3; the terms page has the legal
            shorthand.
          </p>
          <ul class="mt-8 grid gap-4 sm:grid-cols-3">
            <li
              v-for="item in pillars"
              :key="item.title"
              class="rounded-xl border border-neutral-200 bg-white p-4 text-sm leading-relaxed text-neutral-600"
            >
              <span class="font-semibold text-neutral-900">{{ item.title }}</span>
              <span class="mt-1 block">{{ item.body }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section id="wake" class="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
        <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">
          Wake on work — not an idle heartbeat
        </h2>
        <div class="mt-6 space-y-4 text-base leading-relaxed text-neutral-700">
          <p>
            The agent doesn’t sit in a tight loop asking “is there anything new?” on a timer
            just to stay alive. When something actually needs attention, the main process
            <strong>queues a message and wakes the UI to drain the queue</strong> — so runs
            are tied to real inputs (new mail ingested, a Telegram message, a calendar
            ping, a schedule that became due), not to a generic heartbeat.
          </p>
          <p>
            <strong>Telegram</strong> is wired to the client’s <strong>incoming message</strong>
            path: when a message lands, it’s deduplicated, recorded on the right bus, and the
            agent gets queued — that’s event-shaped, not “poll every second.”
          </p>
          <p>
            I’ll be straight with you: <strong>Gmail and Google Calendar</strong> use a
            <strong>slow periodic sync</strong> (on the order of minutes) to pick up new
            threads and events, because that’s what the integration does today. That sync
            isn’t the same thing as the model spinning in a loop — it’s a practical way to
            notice changes until a push-style path is worth the complexity. When something
            new shows up, it still enters the same bus history and can queue the agent like
            everything else.
          </p>
          <p>
            <strong>Scheduled tasks</strong> are a separate idea: when a reminder is due, it
            shows up as work — a timed wake-up for something you asked for, not background
            noise.
          </p>
        </div>
      </section>

      <section
        id="channels"
        class="border-t border-neutral-200 bg-neutral-50/80 py-14 sm:py-20"
      >
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">
            One agent, many channels — “as a human” where it matters
          </h2>
          <div class="mt-6 space-y-4 text-base leading-relaxed text-neutral-700">
            <p>
              Conversations don’t live in separate silos that never meet. They’re modeled as
              <strong>message buses</strong>: a desktop “root” chat, Telegram chats, email
              mailboxes, Google calendars, and so on — each with a stable id, all feeding the
              <strong>same</strong> agent run and history the model can pull from when it
              needs background (including pulling more lines from a bus when context isn’t
              in the initial slice).
            </p>
            <p>
              On <strong>Telegram</strong> specifically, the stack uses a <strong>user
              account</strong> session — the same surface you’d use yourself — not a
              stripped-down bot API persona. That’s intentional: it’s “you-shaped” on that
              network, within the limits of what Telegram allows.
            </p>
            <p>
              <strong>Cross-talk</strong> is a normal part of the design: the agent can
              address the desktop, a Telegram peer, and other buses in one coherent turn.
              Outbound lines are tagged with <strong>which bus they belong to</strong>, so
              replies land where they should instead of leaking across threads by accident.
            </p>
          </div>
        </div>
      </section>

      <section id="contacts" class="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
        <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">
          Knowing who’s who — with you in the loop
        </h2>
        <div class="mt-6 space-y-4 text-base leading-relaxed text-neutral-700">
          <p>
            When someone new shows up on a bus, there isn’t always a contact record yet. The
            agent is instructed to <strong>ask you</strong> to create one (name, identifier,
            which buses belong to that person) — because <strong>you</strong> are the one
            who decides who gets to be a known identity in your world, not a silent database
            scrape.
          </p>
          <p>
            If that prompt goes unanswered too many times on the same bus, the bus can be
            <strong>cut off</strong> — a blunt tool against endless anonymous spam. Once a
            contact exists and includes that bus, the counter resets.
          </p>
          <p>
            Contacts also carry <strong>trust</strong>: “normal” vs “root”-level trust
            matters for what the agent is allowed to say or do in a given channel (for
            example, things you only want in a channel you’ve explicitly elevated). Trust is
            a property of <strong>your</strong> roster, not something the model gets to grant
            itself.
          </p>
          <p>
            Separately, the agent can load a small <strong>SOUL.md</strong> identity file from
            your yaaia folder — a fixed personality layer you control, merged into the system
            side of the prompt.
          </p>
        </div>
      </section>

      <section
        id="vm"
        class="border-t border-neutral-200 bg-neutral-50/80 py-14 sm:py-20"
      >
        <div class="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">
            A VM for real work — the host for context and tools
          </h2>
          <div class="mt-6 space-y-4 text-base leading-relaxed text-neutral-700">
            <p>
              Heavy execution is meant to happen <strong>inside a Linux VM</strong> the app
              can start and stop: there’s a control plane that powers machines on and off,
              and a <strong>WebSocket</strong> channel that streams scripts, stdin, stdout, and
              stderr from an agent running <strong>inside</strong> that environment.
            </p>
            <p>
              File and shell-style work goes to <strong>vm-bash</strong> and friends under
              that VM — including a shared mount (the docs talk about <code
                class="rounded bg-neutral-200/80 px-1.5 py-0.5 text-sm"
              >/mnt/shared</code>) so you can build a durable layout without pretending the
              host is a general-purpose Unix box.
            </p>
            <p>
              On purpose, <strong>host filesystem tools were removed from the agent API</strong>:
              if you try to use them, you get pushed toward the VM path instead. The idea is
              that the <strong>host process holds conversation state, buses, and the tool
              surface</strong>, while the messy, arbitrary bits run where you can fence them —
              not sprinkled across your everyday desktop tree by default.
            </p>
            <p>
              Longer term, the same split should make it easier to park execution on a
              <strong>remote machine</strong> if you want the agent’s shell land to live next
              to a server instead of only beside your laptop — that’s directionally where
              the architecture points; today it’s centered on the local VM workflow.
            </p>
          </div>
        </div>
      </section>

      <section id="conversation-code" class="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8">
        <h2 class="text-2xl font-bold tracking-tight sm:text-3xl">
          Conversation as code
        </h2>
        <div class="mt-6 space-y-4 text-base leading-relaxed text-neutral-700">
          <p>
            The “chat” isn’t only prose back-and-forth. The main path is <strong>code-shaped</strong>:
            the model emits TypeScript that runs in a controlled eval loop with your APIs
            (buses, mail, contacts, schedules, VM power, etc.), can spin <strong>vm-bash</strong>
            blocks for shell work, and uses <strong>console logging with bus prefixes</strong>
            to route human-visible lines to the right place mid-run.
          </p>
          <p>
            That means a single turn can mix <strong>planning, tool calls, and multi-bus
            updates</strong> without pretending everything is a single chat bubble. Prefix
            rules and streaming parsers keep the train on the rails so “who said what where”
            stays explicit.
          </p>
          <p>
            There’s even room for <strong>user messages injected while a reply is being
            drafted</strong> — the loop can fold new input in and continue, which matches how
            real conversations interrupt each other.
          </p>
          <p>
            It’s opinionated, sometimes verbose, and very much <strong>still evolving</strong> —
            but the point is simple: treat the agent as something that <strong>acts through
            code and clear routing</strong>, not only through polished paragraphs.
          </p>
        </div>
      </section>

      <section
        id="get"
        class="border-t border-neutral-200 bg-neutral-900 py-16 text-white sm:py-24"
      >
        <div class="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">Don’t rush to build it yet</h2>
          <p class="mt-4 text-lg leading-relaxed text-neutral-300">
            This site is a signpost. The app is early: read the repo, read the license, and
            only dive in if you’re fine with rough edges and things moving. If something here
            sounded too good to be true, trust the source code over this page.
          </p>
          <p class="mt-8">
            <a
              href="https://github.com/ZonD80/yaaia"
              class="inline-flex items-center justify-center rounded-xl border border-white/25 bg-white/10 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/15"
              rel="noopener noreferrer"
              target="_blank"
            >Source on GitHub</a>
          </p>
          <p class="mt-8 text-sm text-neutral-400">
            yaaia.online
          </p>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
const pillars = [
  {
    title: 'Dogfood',
    body: 'Useful to me first, or it doesn’t ship.',
  },
  {
    title: 'Share later',
    body: 'Open when it’s not embarrassing to inflict on friends.',
  },
  {
    title: 'GPLv3',
    body: 'Same freedoms the license promises — see Terms.',
  },
]
</script>
