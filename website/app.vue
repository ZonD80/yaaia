<template>
  <div class="min-h-dvh bg-white text-neutral-900 antialiased">
    <header
      class="sticky top-0 z-50 border-b border-neutral-200/80 bg-white/90 backdrop-blur-md"
    >
      <div
        class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8"
      >
        <NuxtLink to="/" class="flex items-center gap-3">
          <img
            src="/icon.png"
            width="40"
            height="40"
            alt="yaaia"
            class="h-10 w-10 shrink-0"
          />
          <span class="text-lg font-semibold tracking-tight">yaaia</span>
        </NuxtLink>
        <nav
          class="hidden max-w-2xl flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] font-medium leading-tight text-neutral-600 sm:text-xs lg:flex"
        >
          <NuxtLink to="/" class="transition hover:text-neutral-900">Home</NuxtLink>
          <a href="/#why" class="transition hover:text-neutral-900">Why</a>
          <a href="/#wake" class="transition hover:text-neutral-900">Wake</a>
          <a href="/#channels" class="transition hover:text-neutral-900">Channels</a>
          <a href="/#contacts" class="transition hover:text-neutral-900">Contacts</a>
          <a href="/#vm" class="transition hover:text-neutral-900">VM</a>
          <a href="/#conversation-code" class="transition hover:text-neutral-900">Code</a>
          <a href="/#get" class="transition hover:text-neutral-900">Status</a>
          <a
            href="https://github.com/ZonD80/yaaia"
            class="transition hover:text-neutral-900"
            rel="noopener noreferrer"
            target="_blank"
          >GitHub</a>
          <NuxtLink to="/privacy" class="transition hover:text-neutral-900">Privacy</NuxtLink>
          <NuxtLink to="/terms" class="transition hover:text-neutral-900">Terms</NuxtLink>
        </nav>
        <button
          type="button"
          class="inline-flex items-center justify-center rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 transition hover:bg-neutral-50 lg:hidden"
          aria-label="Open menu"
          @click="mobileOpen = !mobileOpen"
        >
          <span v-if="!mobileOpen">Menu</span>
          <span v-else>Close</span>
        </button>
      </div>
      <div
        v-show="mobileOpen"
        class="border-t border-neutral-200 bg-white px-4 py-4 lg:hidden"
      >
        <div class="flex flex-col gap-3 text-sm font-medium text-neutral-700">
          <NuxtLink to="/" class="py-1" @click="mobileOpen = false">Home</NuxtLink>
          <a href="/#why" class="py-1" @click="mobileOpen = false">Why</a>
          <a href="/#wake" class="py-1" @click="mobileOpen = false">Wake</a>
          <a href="/#channels" class="py-1" @click="mobileOpen = false">Channels</a>
          <a href="/#contacts" class="py-1" @click="mobileOpen = false">Contacts</a>
          <a href="/#vm" class="py-1" @click="mobileOpen = false">VM</a>
          <a href="/#conversation-code" class="py-1" @click="mobileOpen = false">Code</a>
          <a href="/#get" class="py-1" @click="mobileOpen = false">Status</a>
          <a
            href="https://github.com/ZonD80/yaaia"
            class="py-1"
            rel="noopener noreferrer"
            target="_blank"
            @click="mobileOpen = false"
          >GitHub</a>
          <NuxtLink to="/privacy" class="py-1" @click="mobileOpen = false">Privacy</NuxtLink>
          <NuxtLink to="/terms" class="py-1" @click="mobileOpen = false">Terms</NuxtLink>
        </div>
      </div>
    </header>

    <NuxtPage />

    <footer class="border-t border-neutral-200 py-10">
      <div
        class="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-4 sm:flex-row sm:px-6 lg:px-8"
      >
        <div class="flex items-center gap-2">
          <img src="/icon.png" alt="" width="28" height="28" class="h-7 w-7 opacity-90" />
          <span class="text-sm font-medium text-neutral-700">yaaia</span>
        </div>
        <nav class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-neutral-600">
          <a
            href="https://github.com/ZonD80/yaaia"
            class="transition hover:text-neutral-900"
            rel="noopener noreferrer"
            target="_blank"
          >GitHub</a>
          <NuxtLink to="/privacy" class="transition hover:text-neutral-900">Privacy policy</NuxtLink>
          <NuxtLink to="/terms" class="transition hover:text-neutral-900">Terms of service</NuxtLink>
        </nav>
        <p class="text-center text-sm text-neutral-500 sm:text-right">
          © {{ year }} · GPLv3
        </p>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
const mobileOpen = ref(false)
const year = new Date().getFullYear()
</script>
