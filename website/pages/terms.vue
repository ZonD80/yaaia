<template>
  <main class="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
    <h1 class="text-3xl font-bold tracking-tight sm:text-4xl">Terms of service</h1>
    <p class="mt-2 text-sm text-neutral-500">Last updated: {{ updated }}</p>

    <div class="mt-10 space-y-6 text-base leading-relaxed text-neutral-700">
      <p>
        These terms apply to your use of the <strong>yaaia.online</strong> website and the
        <strong>yaaia application</strong> together, unless a section states otherwise. The
        software is offered under the <strong>GNU General Public License version 3</strong>
        (GNU GPLv3). By using the site or the software, you agree to the following.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Software license</h2>
      <p>
        The yaaia software is free software released under the
        <a
          href="https://www.gnu.org/licenses/gpl-3.0.html"
          class="font-medium text-neutral-900 underline-offset-4 hover:underline"
          rel="noopener noreferrer"
        >GNU General Public License, version 3</a>.
        Your rights and obligations regarding copying, modifying, and distributing the
        program are governed entirely by that license, including its requirements to
        pass on the same freedoms when you convey covered works.
      </p>
      <p>
        A copy of the license text is included in the project repository as the
        <code class="rounded bg-neutral-100 px-1.5 py-0.5 text-sm">LICENSE</code> file.
        If there is any conflict between a short summary on this page and the terms of
        GPLv3, <strong>the GPLv3 text prevails</strong>.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">No warranty</h2>
      <p>
        The program is provided <strong>“as is”</strong>, without warranty of any kind,
        either express or implied, including but not limited to the implied warranties of
        merchantability and fitness for a particular purpose. This follows from the GNU
        GPLv3, which states that there is <strong>no warranty for the free software</strong>,
        to the extent permitted by applicable law.
      </p>
      <p>
        <strong>There is no guarantee</strong> that the software or the website will be
        uninterrupted, error-free, secure, or suitable for any particular purpose. You use
        them at your own risk.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Limitation of liability</h2>
      <p>
        To the maximum extent permitted by applicable law, in no event shall the
        copyright holders or contributors be liable for any direct, indirect, incidental,
        special, exemplary, or consequential damages (including procurement of substitute
        goods or services; loss of use, data, or profits; or business interruption) arising
        in any way out of the use of this software or this website, even if advised of the
        possibility of such damage — as set out in the GNU GPLv3 and subject to applicable
        law.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Website</h2>
      <p>
        The site is provided for information about the project. You agree not to misuse it
        (for example by attempting to disrupt service or access systems without authorization).
        We may suspend or restrict access where necessary to protect the service or others.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Application</h2>
      <p>
        You are responsible for how you configure and use the app — including API keys,
        connected accounts, VMs, and data you process. You must comply with the terms of any
        third-party services you connect and with applicable law. Nothing in these terms
        overrides the GPLv3 for the software.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Third parties</h2>
      <p>
        The website may link to third-party sites or services. We are not responsible for
        their content or practices. The application may integrate with services you choose;
        your relationship with those providers is between you and them.
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Changes</h2>
      <p>
        These terms may be updated from time to time. The “Last updated” date at the top
        will change when they are revised. Continued use of the website or the application
        after changes constitutes acceptance of the updated terms (except where the GPLv3
        governs the software, which remains under GPLv3 as published by the Free Software
        Foundation).
      </p>

      <h2 class="pt-4 text-xl font-semibold text-neutral-900">Governing law</h2>
      <p>
        Where required, applicable law may govern interpretation of these terms for the
        website and for matters not covered by the GPLv3. For the software itself, the GNU
        GPLv3 applies worldwide as stated in that license.
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
  title: 'Terms of service — yaaia',
  meta: [
    {
      name: 'description',
      content:
        'Terms of service for yaaia website and application: GNU GPLv3, no warranty, limitation of liability.',
    },
  ],
})
</script>
