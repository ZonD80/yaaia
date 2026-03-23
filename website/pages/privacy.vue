<template>
  <main class="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
    <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">Privacy policy</h1>
    <p class="mt-2 text-sm text-neutral-500">Last updated: {{ updated }}</p>

    <div class="mt-10 space-y-6 text-base leading-relaxed text-neutral-700">
      <p>
        This policy applies to the <strong>yaaia.online</strong> website and the
        <strong>yaaia application</strong> (desktop / local software from the same project)
        together. Where something applies only to the site or only to the app, we say so
        below.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Website (yaaia.online)</h2>
      <p>
        The public site is <strong>static</strong>: pre-built pages served to your browser.
        There is no account system on the site, no forms that submit to us there, and no
        server-side processing of your personal data by us for that website.
      </p>
      <p>
        <strong>We do not use the website to collect personal data for our own analytics or
        marketing.</strong> We do not use analytics, advertising pixels, or similar trackers
        on these pages to identify you or profile your behaviour.
      </p>
      <p>
        The site does not set cookies for tracking or marketing. Your browser may still
        store ordinary technical data (for example cache) as part of how the web works;
        that is under your browser’s control.
      </p>
      <p>
        The site is hosted on infrastructure operated by a provider (for example
        Cloudflare). That provider may process technical data such as IP addresses and
        request metadata when pages are delivered — under their own terms and privacy
        policy.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Application (yaaia)</h2>
      <p>
        The app runs <strong>on your machine</strong> (and any VM or environment you attach
        locally). We do not operate a central “yaaia cloud” that stores your conversations
        or files on our servers as part of using the app.
      </p>
      <p>
        Data the app creates — chats, buses, local databases, configuration, credentials you
        enter, and similar — stay <strong>under your control</strong> on your devices and in
        paths the software uses, unless <strong>you</strong> send that data elsewhere (for
        example to an AI API, email, Telegram, or another service you connect).
      </p>
      <p>
        When you connect third-party services or API providers, your use of those services is
        governed by <strong>their</strong> terms and privacy policies. The app may transmit
        prompts, tool results, or messages to providers you configure; you choose those
        providers and what to send.
      </p>
      <p>
        We do not sell your personal information. This project is open source; if you build
        or modify the software yourself, you are responsible for what your build does.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Changes</h2>
      <p>
        If this policy changes in a material way, we will update the date at the top of this
        page. Continued use of the website or the app after changes means you accept the
        updated policy (in addition to any license terms that apply to the software).
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Contact</h2>
      <p>
        For questions about this privacy policy, use the contact method published in the
        project repository (for example GitHub), if any.
      </p>

      <p class="mt-12">
        <NuxtLink to="/" class="font-medium text-neutral-900 underline-offset-4 hover:underline">
          ← Back to home
        </NuxtLink>
      </p>
    </div>
  </main>
</template>

<script setup lang="ts">
const updated = 'March 23, 2026'

useHead({
  title: 'Privacy policy — yaaia',
  meta: [
    {
      name: 'description',
      content:
        'Privacy policy for yaaia: yaaia.online static site and local yaaia application — no marketing analytics on the site; app data stays on your devices unless you send it to third parties you configure.',
    },
  ],
})
</script>
