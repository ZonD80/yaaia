<template>
  <div class="app" @click="onAppLinkClick">
    <header class="header">
      <h1>YAAIA <span class="version">v{{ appVersion }}</span></h1>
    </header>
    <div v-if="taskSummary" class="floating-task"
      :class="{ finalized: taskFinalized, failed: taskFinalized && !taskSuccess }">
      <span class="floating-task-name">{{ taskSummary }}</span>
      <span class="floating-task-timer">{{ formatElapsed(taskElapsedSeconds) }}</span>
    </div>
    <main class="main">
      <section class="config" v-if="!agentReady">
        <h2>Configuration</h2>
        <div class="field">
          <label>Provider</label>
          <select v-model="config.aiProvider">
            <option value="claude">Claude</option>
            <option value="openrouter">OpenRouter</option>
            <option value="codex">Codex (ChatGPT Plus/Pro)</option>
          </select>
        </div>
        <div class="field" v-if="config.aiProvider === 'claude'">
          <label>Claude API Key</label>
          <input type="password" v-model="config.claudeApiKey" placeholder="sk-ant-..." />
        </div>
        <div class="field" v-if="config.aiProvider === 'claude'">
          <label>Claude Model</label>
          <input v-model="config.claudeModel" placeholder="claude-sonnet-4-6" />
        </div>
        <div class="field" v-if="config.aiProvider === 'openrouter'">
          <label>OpenRouter API Key</label>
          <input type="password" v-model="config.openrouterApiKey" placeholder="sk-or-..." />
        </div>
        <div class="field" v-if="config.aiProvider === 'openrouter'">
          <label>OpenRouter Model</label>
          <input v-model="config.openrouterModel" placeholder="google/gemini-2.5-flash" />
        </div>
        <div class="field" v-if="config.aiProvider === 'codex'">
          <label>Codex (ChatGPT Plus/Pro)</label>
          <div class="codex-auth-row">
            <span v-if="codexAuthenticated" class="codex-status">✓ Logged in</span>
            <span v-else class="codex-status muted">Not logged in</span>
            <button type="button" class="btn secondary" @click="codexLogin" :disabled="codexLoggingIn">
              {{ codexLoggingIn ? "Logging in…" : codexAuthenticated ? "Re-login" : "Login with ChatGPT" }}
            </button>
            <button v-if="codexAuthenticated" type="button" class="btn secondary" @click="codexLogout">Logout</button>
          </div>
        </div>
        <div class="field" v-if="config.aiProvider === 'codex'">
          <label>Codex Model</label>
          <input v-model="config.codexModel" placeholder="gpt-5.4-codex" />
        </div>
        <div class="field">
          <label>Your name (root bus)</label>
          <input v-model="config.userName" placeholder="e.g. Alice" />
        </div>
        <div class="field">
          <label>Who uses root chat (identifier)</label>
          <input v-model="config.rootUserIdentifier" placeholder="e.g. aleksei (empty = use identity)" />
          <p class="editor-hint">from_identifier for your messages. Assistant replies use "assistant".</p>
        </div>
        <div class="field vm-section">
          <label>Linux VM</label>
          <p v-if="vmMessage" class="vm-message" :class="{ error: vmMessageError }">{{ vmMessage }}</p>
          <template v-if="vms.length === 0">
            <button type="button" class="btn secondary small" @click="refreshVmList" :disabled="vmRefreshing"
              style="margin-bottom: 0.5rem;">Refresh</button>
            <div class="vm-create-form">
              <div class="field-inline">
                <label>ISO file</label>
                <input v-model="vmCreateForm.isoPath" placeholder="Path to Linux ISO (arm64)" readonly
                  class="iso-path" />
                <button type="button" class="btn secondary small" @click="pickIso">Browse…</button>
              </div>
              <div class="field-inline">
                <label>Disk (GB)</label>
                <input v-model.number="vmCreateForm.diskGb" type="number" min="8" max="512" placeholder="20" />
              </div>
              <div class="field-inline">
                <label>RAM (MB)</label>
                <input v-model.number="vmCreateForm.ramMb" type="number" min="2048" max="65536" placeholder="4096" />
              </div>
              <button type="button" class="btn secondary" @click="createVm" :disabled="vmCreating">
                {{ vmCreating ? "Creating…" : "Create VM" }}
              </button>
            </div>
          </template>
          <template v-else>
            <button type="button" class="btn secondary small" @click="refreshVmList" :disabled="vmRefreshing"
              style="margin-bottom: 0.5rem;">Refresh</button>
            <div class="vm-actions">
              <span class="vm-info">{{ vms[0].name }} — {{ vms[0].ramMb }} MB RAM, {{ vms[0].diskGb }} GB disk ({{
                vms[0].status }})</span>
              <button type="button" class="btn secondary small" @click="startVm(vms[0].id)"
                :disabled="vms[0].status === 'running' || vmStarting">
                {{ vmStarting ? "Starting…" : "Start" }}
              </button>
              <button type="button" class="btn secondary small" @click="stopVm(vms[0].id)"
                :disabled="vms[0].status !== 'running'">
                Stop
              </button>
              <button type="button" class="btn secondary small" @click="showConsoleVm(vms[0].id)"
                :disabled="vms[0].status !== 'running'">
                Show console
              </button>
              <button type="button" class="btn secondary small" @click="deleteVm(vms[0].id)">Delete</button>
            </div>
          </template>
        </div>
        <ul v-if="startupSteps.length" class="startup-progress">
          <li v-for="(step, i) in startupSteps" :key="i"
            :class="{ done: i < startupSteps.length - 1 || startupMilestones.includes(step) }">
            <span class="check">{{ (i < startupSteps.length - 1 || startupMilestones.includes(step)) ? "✓" : ""
            }}</span>
                <span class="text">{{ step }}</span>
          </li>
        </ul>
        <div class="field-inline" style="margin-bottom: 0.5rem;">
          <input v-model="config.setupMode" type="checkbox" id="setup-mode" />
          <label for="setup-mode">Setup mode</label>
        </div>
        <div class="field-inline" style="margin-bottom: 0.5rem;">
          <input v-model="config.enableMdParsing" type="checkbox" id="enable-md-parsing" />
          <label for="enable-md-parsing">Enable MD parsing</label>
        </div>
        <div class="field-inline" style="margin-bottom: 0.5rem;">
          <input v-model="skipInitialTask" type="checkbox" id="skip-initial-task" />
          <label for="skip-initial-task">Do not send initial task</label>
        </div>
        <button class="btn primary" @click="startChat" :disabled="starting">
          {{ starting ? "Starting..." : "Start chat" }}
        </button>
      </section>
      <section class="chat" v-else>
        <div v-if="agentReady && !config.rootUserIdentifierDefined && !rootIdentifierWarningDismissed"
          class="root-identifier-warning">
          <span>Root chat history is not saved. Set "Who uses root chat (identifier)" in config.</span>
          <button type="button" class="root-identifier-warning-close" @click="rootIdentifierWarningDismissed = true"
            title="Dismiss">×</button>
        </div>
        <div class="chat-messages" ref="messagesRef">
          <div v-if="rootHistoryLoadedCount < rootHistoryTotal" class="chat-load-older">
            <button type="button" class="btn secondary small" @click="loadOlderMessages">
              Load older messages ({{ rootHistoryTotal - rootHistoryLoadedCount }} more)
            </button>
          </div>
          <div v-if="messages.length === 0" class="chat-placeholder">Agent is ready. Type your message below.</div>
          <div v-for="(msg, i) in messagesWithPrettified" :key="`${msg.timestamp ?? ''}-${msg.role}-${i}`"
            :class="['msg', msg.role, { error: msg.isError, report: msg.isReport }, msg.type]">
            <span v-if="msg.timestamp" class="msg-timestamp">
              {{ formatTimestamp(msg.timestamp) }}{{ (msg.bus_id || msg._prettified.busId) ? ` · ${msg.bus_id || msg._prettified.busId}` : "" }}
            </span>
            <template v-if="msg.role === 'user'">
              <div v-if="msg.isTelegram" class="msg-markdown" v-html="msg._prettified.html || renderContent(msg.content)"></div>
              <span v-else class="msg-text">{{ msg.content }}</span>
            </template>
            <template v-else>
              <div v-if="msg.isError" class="msg-error">{{ msg.content }}</div>
              <template v-else-if="msg.type === 'assessment'">
                <span class="msg-type-label">{{ msg.bus_id ? `Remote bus (${msg.bus_id}) assessment` : 'Assessment'
                }}</span>
                <div class="msg-markdown" v-html="msg._prettified.html || renderContent(msg.content)"></div>
              </template>
              <template v-else-if="msg.type === 'clarification'">
                <span class="msg-type-label">{{ msg.bus_id ? `Remote bus (${msg.bus_id}) clarification` :
                  'Clarification' }}</span>
                <div class="msg-markdown" v-html="msg._prettified.html || renderContent(msg.content)"></div>
              </template>
              <template v-else-if="msg.type === 'memory'">
                <span class="msg-type-label">Memory</span>
                <div class="msg-markdown" v-html="msg._prettified.html || renderContent(msg.content)"></div>
              </template>
              <template v-else-if="msg.isReport && msg.content">
                <span class="msg-type-label">Detailed report</span>
                <div class="msg-markdown" v-html="msg._prettified.html || renderContent(msg.content)"></div>
              </template>
              <div v-else-if="msg.content" class="msg-markdown" v-html="msg._prettified.html || renderContent(msg.content)"></div>
            </template>
          </div>
          <template v-if="streaming">
            <div v-for="(p, pi) in streamingParsedWithPrettified.parts" :key="'stream-' + pi" :class="['msg', p.role, p.type]">
              <span v-if="p.bus_id || p._prettified.busId" class="msg-timestamp">· {{ p.bus_id || p._prettified.busId }}</span>
              <template v-if="p.role === 'user'">
                <div v-if="p.isTelegram" class="msg-markdown" v-html="p._prettified.html || renderContent(p.content)"></div>
                <span v-else class="msg-text">{{ p.content }}</span>
              </template>
              <template v-else-if="p.type === 'assessment'">
                <span class="msg-type-label">{{ p.bus_id ? `Remote bus (${p.bus_id}) assessment` : 'Assessment'
                }}</span>
                <div class="msg-markdown" v-html="p._prettified.html || renderContent(p.content)"></div>
              </template>
              <template v-else-if="p.type === 'clarification'">
                <span class="msg-type-label">{{ p.bus_id ? `Remote bus (${p.bus_id}) clarification` : 'Clarification'
                }}</span>
                <div class="msg-markdown" v-html="p._prettified.html || renderContent(p.content)"></div>
              </template>
              <div v-else-if="p.content" class="msg-markdown" v-html="p._prettified.html || renderContent(p.content)"></div>
            </div>
            <div class="msg assistant">
              <div v-if="streamingParsed.tail" class="msg-markdown" v-html="streamingParsedWithPrettified.tailPrettified.html || renderContent(streamingParsed.tail)"></div>
              <span v-else-if="!streamingParsed.parts.some((p) => p.type === 'thinking')">Thinking…</span>
            </div>
          </template>
          <div ref="scrollAnchor" aria-hidden="true"></div>
        </div>
        <div class="chat-input">
          <div class="chat-input-row">
            <textarea ref="messageTextareaRef" v-model="inputText"
              :placeholder="sending ? 'Type to inject message…' : 'Ask the agent...'" rows="2"
              @keydown.enter.exact.prevent="send" @focus="textareaFocused = true" @blur="textareaFocused = false" />
            <button class="btn secondary" @click="stopAgent" :disabled="!sending">Stop</button>
            <button class="btn primary" @click="send" :disabled="!inputText.trim()">{{ sending ? 'Inject' : 'Send'
            }}</button>
          </div>
          <p class="chat-scroll-hint">Click outside the message box to stop automatic scrolling</p>
        </div>
      </section>
      <aside class="sidebar">
        <button class="btn secondary" @click="authorizeGoogleApi">Authorize Google API for agent</button>
        <button class="btn secondary" @click="openPasswordsEditor">Passwords Editor</button>
        <button class="btn secondary" @click="openIdentitiesEditor">Identities Editor</button>
        <button class="btn secondary" @click="openScheduleEditor">Schedules</button>
        <button class="btn secondary" @click="viewRecipe">View recipe</button>
        <button class="btn secondary" @click="saveRecipe">Save recipe</button>
        <button class="btn secondary" @click="loadRecipe">Load recipe</button>
        <button class="btn secondary" @click="openBusStatuses">Bus statuses</button>
        <button class="btn secondary" @click="openVmSerialConsole">VM Serial Console</button>
        <button class="btn secondary" @click="openStorageFolder">Open storage folder</button>
        <button class="btn secondary" @click="exitChat">Exit chat</button>
      </aside>
    </main>
    <div v-if="telegramLoginStep" class="ask-user-overlay">
      <div class="ask-user-modal">
        <h3>Telegram login</h3>
        <p class="ask-user-clarification">{{ telegramLoginLabel }}</p>
        <input v-model="telegramLoginValue" :type="telegramLoginStep === 'phone' ? 'tel' : 'password'"
          :placeholder="telegramLoginPlaceholder" class="editor-input" @keydown.enter="submitTelegramLogin" />
        <div class="ask-user-actions">
          <button class="btn primary" @click="submitTelegramLogin">Submit</button>
        </div>
      </div>
    </div>
    <div v-if="askUserInfo" class="ask-user-overlay">
      <div class="ask-user-modal">
        <h3>Agent needs your input</h3>
        <div v-if="askUserInfo.clarification" class="ask-user-clarification msg-markdown"
          v-html="renderContent(askUserInfo.clarification)"></div>
        <div v-if="askUserInfo.assessment" class="ask-user-assessment msg-markdown"
          v-html="renderContent(askUserInfo.assessment)"></div>
        <p class="ask-user-countdown">Reply within {{ askUserCountdown }} seconds</p>
        <textarea v-model="askUserReply" placeholder="Type your reply..." rows="4"
          @keydown.enter.ctrl="submitAskUserReply" />
        <div class="ask-user-actions">
          <button class="btn primary" @click="submitAskUserReply">Send</button>
          <button class="btn secondary" @click="dismissAskUser">Cancel</button>
        </div>
      </div>
    </div>
    <div v-if="showFinalizePopup" class="ask-user-overlay" @click.self="dismissFinalize">
      <div class="ask-user-modal finalize-modal"
        :class="{ 'finalize-failed': finalizeInfo && !finalizeInfo.is_successful }">
        <h3>Task {{ finalizeInfo?.is_successful ? 'completed' : 'failed' }}</h3>
        <div class="ask-user-actions">
          <button class="btn primary" @click="dismissFinalize">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showPasswordsEditor" class="ask-user-overlay editor-overlay" @click.self="showPasswordsEditor = false">
      <div class="ask-user-modal editor-modal">
        <h3>Passwords Editor</h3>
        <p class="editor-hint">Passwords and TOTPs only. Description can be dot notation (e.g. database.password,
          github.totp). Usernames, hosts, ports go in KB md files.</p>
        <p v-if="passwordsError" class="editor-error">{{ passwordsError }}</p>
        <div class="editor-form">
          <input v-model="passwordsForm.description" type="text"
            placeholder="Description (e.g. database.password, github.totp)" class="editor-input" />
          <select v-model="passwordsForm.type" class="editor-input">
            <option value="string">Password</option>
            <option value="totp">TOTP</option>
          </select>
          <input v-model="passwordsForm.value" type="text"
            :placeholder="passwordsForm.type === 'totp' ? 'TOTP seed (Base32)' : 'Value (plaintext)'"
            class="editor-input" />
          <div class="editor-form-actions">
            <button class="btn primary" @click="savePassword">{{ passwordsEditingId ? "Update" : "Add" }}</button>
            <button v-if="passwordsEditingId" class="btn secondary" @click="startAddPassword">Cancel edit</button>
          </div>
        </div>
        <div class="editor-list">
          <div v-for="item in passwordsItems" :key="item.uuid" class="editor-row">
            <div class="editor-row-fields">
              <span class="editor-row-desc">{{ item.description }}</span>
              <span class="editor-row-type">{{ item.type }}</span>
              <span v-if="item.type === 'totp'" class="editor-row-badge">TOTP</span>
            </div>
            <div class="editor-row-actions">
              <button class="btn secondary small" @click="startEditPassword(item)">Edit</button>
              <button class="btn secondary small" @click="deletePassword(item.uuid)">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddPassword">Add new</button>
          <button class="btn secondary" @click="showPasswordsEditor = false">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showIdentitiesEditor" class="ask-user-overlay editor-overlay" @click.self="showIdentitiesEditor = false">
      <div class="ask-user-modal editor-modal">
        <h3>Identities Editor</h3>
        <p class="editor-hint">Identities map buses to memory partitions. identifier = memory key. bus_ids =
          comma-separated
          (e.g. telegram-123, email-account).</p>
        <p v-if="identitiesError" class="editor-error">{{ identitiesError }}</p>
        <div class="editor-form">
          <input v-model="identitiesForm.name" type="text" placeholder="Name" class="editor-input" />
          <input v-model="identitiesForm.identifier" type="text"
            placeholder="Identifier (e.g. self, email@example.com, google-account-calendar_id)" class="editor-input" />
          <select v-model="identitiesForm.trust_level" class="editor-input">
            <option value="normal">normal</option>
            <option value="root">root</option>
          </select>
          <input v-model="identitiesForm.bus_ids_str" type="text" placeholder="bus_ids (comma-separated)"
            class="editor-input" />
          <div class="editor-form-actions">
            <button class="btn primary" @click="saveIdentity">{{ identitiesEditingId ? "Update" : "Add" }}</button>
            <button v-if="identitiesEditingId" class="btn secondary" @click="startAddIdentity">Cancel edit</button>
          </div>
        </div>
        <div class="editor-list">
          <div v-for="item in identitiesItems" :key="item.id" class="editor-row">
            <div class="editor-row-fields">
              <span class="editor-row-desc">{{ item.name }}</span>
              <span class="editor-row-type">{{ item.identifier }}</span>
              <span class="editor-row-badge">{{ item.trust_level }}</span>
              <span class="editor-row-value">{{ item.bus_ids.join(", ") || "—" }}</span>
            </div>
            <div class="editor-row-actions">
              <button class="btn secondary small" @click="startEditIdentity(item)">Edit</button>
              <button class="btn secondary small" @click="openIdentityNote(item)">Note</button>
              <button class="btn secondary small" @click="deleteIdentity(item)">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddIdentity">Add new</button>
          <button class="btn secondary" @click="showIdentitiesEditor = false">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showIdentityNoteEditor" class="ask-user-overlay editor-overlay"
      @click.self="showIdentityNoteEditor = false">
      <div class="ask-user-modal editor-modal">
        <h3>Note: {{ identityNoteTarget?.name ?? identityNoteTarget?.identifier }}</h3>
        <p v-if="identityNoteError" class="editor-error">{{ identityNoteError }}</p>
        <textarea v-model="identityNoteContent" placeholder="Markdown note..." rows="12"
          class="editor-textarea"></textarea>
        <div class="editor-form-actions">
          <button class="btn primary" @click="saveIdentityNote">Save</button>
          <button class="btn secondary" @click="showIdentityNoteEditor = false">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showScheduleEditor" class="ask-user-overlay editor-overlay" @click.self="showScheduleEditor = false">
      <div class="ask-user-modal editor-modal schedule-editor-modal">
        <h3>Schedules</h3>
        <p v-if="scheduleError" class="editor-error">{{ scheduleError }}</p>
        <div class="schedule-editor-layout">
          <div class="schedule-editor-list">
            <div v-for="s in scheduleListWithZero" :key="s.id" class="schedule-editor-item"
              :class="{ selected: scheduleSelectedId === s.id, 'schedule-zero': s.id === 'zero' }"
              @click="selectSchedule(s)">
              <span class="schedule-item-title">{{ s.title }}</span>
              <span class="schedule-item-at">{{ s.id === 'zero' ? 'On app start' : formatScheduleAt(s.at) }}</span>
            </div>
          </div>
          <div class="schedule-editor-form">
            <input v-if="scheduleSelectedId !== 'zero'" v-model="scheduleFormAt" type="datetime-local"
              class="editor-input" />
            <input v-model="scheduleFormTitle" type="text" placeholder="Title" class="editor-input" />
            <textarea v-model="scheduleFormInstructions" placeholder="Instructions..." rows="8"
              class="editor-textarea"></textarea>
            <div class="editor-form-actions">
              <button class="btn primary" @click="saveSchedule" :disabled="scheduleSaving">
                {{ scheduleSaving ? "Saving…" : (scheduleSelectedId ? "Update" : "Add") }}
              </button>
              <button v-if="scheduleSelectedId && scheduleSelectedId !== 'zero'" class="btn secondary"
                @click="deleteSchedule" :disabled="scheduleSaving">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddSchedule">Add new</button>
          <button class="btn secondary" @click="showScheduleEditor = false">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showBusStatuses" class="ask-user-overlay editor-overlay" @click.self="showBusStatuses = false">
      <div class="ask-user-modal editor-modal bus-status-modal">
        <h3>Bus statuses</h3>
        <div class="bus-status-list">
          <div v-for="bus in busStatusList" :key="bus.bus_id" class="bus-status-row">
            <span class="bus-status-dot" :class="bus.is_connected ? 'online' : 'offline'"></span>
            <span class="bus-status-name">{{ bus.description || bus.bus_id }}</span>
            <span class="bus-status-id">{{ bus.bus_id }}</span>
            <span class="bus-status-label" :class="bus.is_connected ? 'online' : 'offline'">
              {{ bus.is_connected ? 'online' : 'offline' }}
            </span>
          </div>
          <div v-if="busStatusList.length === 0" class="editor-hint">No buses found.</div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="showBusStatuses = false">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { marked } from "marked";

marked.setOptions({ breaks: true });

const appVersion = __APP_VERSION__;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  injected?: boolean;
  isError?: boolean;
  isReport?: boolean;
  isTelegram?: boolean;
  type?: "assessment" | "clarification" | "tool_running" | "tool_call" | "content" | "memory" | "thinking";
  name?: string;
  accordion?: string;
  wait_seconds?: number;
  bus_id?: string;
};

const MSG_START = "<<<MSG>>>";
const MSG_END = "<<<END>>>";

function parseStream(raw: string): { parts: ChatMessage[]; tail: string } {
  const parts: ChatMessage[] = [];
  let remaining = raw;
  let contentBuffer = "";

  while (true) {
    const idx = remaining.indexOf(MSG_START);
    if (idx === -1) {
      contentBuffer += remaining;
      break;
    }
    contentBuffer += remaining.slice(0, idx);
    const after = remaining.slice(idx + MSG_START.length);
    const endIdx = after.indexOf(MSG_END);
    if (endIdx === -1) {
      contentBuffer += MSG_START + after;
      break;
    }
    const jsonStr = after.slice(0, endIdx);
    remaining = after.slice(endIdx + MSG_END.length);
    try {
      const msg = JSON.parse(jsonStr) as { type?: string; content?: string; name?: string; accordion?: string; wait_seconds?: number; bus_id?: string };
      if (contentBuffer.trim()) {
        parts.push({ role: "assistant", content: contentBuffer.trim(), type: "content" });
        contentBuffer = "";
      }
      if (msg.type === "content_end") {
        /* flush handled above */
      } else if (msg.type === "assessment" && typeof msg.content === "string") {
        parts.push({ role: "assistant", content: msg.content, type: "assessment", bus_id: msg.bus_id });
      } else if (msg.type === "clarification" && typeof msg.content === "string") {
        parts.push({ role: "assistant", content: msg.content, type: "clarification", bus_id: msg.bus_id });
      } else if (msg.type === "tool_running" && msg.name) {
        parts.push({ role: "assistant", content: `Tool: ${msg.name} running…`, type: "content" });
      } else if (msg.type === "tool_call" && msg.name) {
        const last = parts[parts.length - 1];
        if (last?.content === `Tool: ${msg.name} running…`) parts.pop();
        parts.push({ role: "assistant", content: msg.content ?? "", type: "content" });
      } else if (msg.type === "user_injected" && typeof msg.content === "string") {
        parts.push({ role: "user", content: msg.content });
      } else if (msg.type === "thinking") {
        const last = parts[parts.length - 1];
        if (last?.type === "thinking") parts.pop();
        parts.push({ role: "assistant", content: "Thinking…", type: "thinking" });
      }
    } catch {
      contentBuffer += MSG_START + jsonStr + MSG_END;
    }
  }
  return { parts, tail: contentBuffer };
}

function renderMarkdown(text: string): string {
  if (!text?.trim()) return "";
  return marked.parse(text) as string;
}

function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

/** Valid bus_id pattern (root, telegram-123, email-x, etc.) */
const BUS_ID_RE = /^([a-zA-Z0-9_-]+):(wait:)?(.*)$/;

/** Parse bbtags [X=ts]...[/X] and [X=vm-bash:N:user]...[/X], replace with accordion. */
function parseBbtagsToAccordions(text: string): string {
  const re = /\[([a-zA-Z0-9_-]+)=(ts|vm-bash:\d+:\w+)\]([\s\S]*?)\[\/\1\]/g;
  return text.replace(re, (_, _tag, type, code) => {
    const escaped = (code ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const label = type === "ts" ? "TypeScript" : type.startsWith("vm-bash:") ? "vm-bash" : type;
    return `<details class="msg-code-accordion"><summary>${escapeHtml(label)}</summary><pre><code>${escaped}</code></pre></details>`;
  });
}

type PrettifiedMessage = {
  busId?: string;
  html: string;
};

/** Prettify chat content: extract bus_id, parse bbtags to accordions, parse markdown. Only when enableMdParsing. */
function prettifyChatContent(
  rawContent: string,
  enableMdParsing: boolean
): PrettifiedMessage {
  if (!rawContent?.trim()) return { html: "" };
  let busId: string | undefined;
  let body = rawContent;

  const firstNewline = rawContent.indexOf("\n");
  const firstLine = firstNewline >= 0 ? rawContent.slice(0, firstNewline) : rawContent;
  const rest = firstNewline >= 0 ? rawContent.slice(firstNewline + 1) : "";
  const m = firstLine.match(BUS_ID_RE);
  if (m && m[1]) {
    busId = m[1];
    body = (m[3] ?? "").trim();
    if (rest) body = body ? body + "\n" + rest : rest;
  }

  if (!enableMdParsing) {
    return { busId, html: escapeHtml(body || rawContent) };
  }

  const withAccordions = parseBbtagsToAccordions(body || rawContent);
  const html = renderMarkdown(withAccordions);
  return { busId, html };
}

function renderContent(text: string): string {
  if (!text?.trim()) return "";
  return config.value.enableMdParsing ? renderMarkdown(text) : escapeHtml(text);
}

/** Open links in external browser. Used globally so links in chat, popups, reports, etc. all open externally. */
function onAppLinkClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement)?.closest?.("a");
  if (!anchor?.href) return;
  const url = anchor.getAttribute("href");
  if (!url || !/^(https?|mailto):/i.test(url)) return;
  e.preventDefault();
  e.stopPropagation();
  window.electronAPI?.openExternal?.(url);
}

function formatElapsed(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${d}d ${h}h ${m}m ${s}s`;
}

function startTaskTimer() {
  if (taskTimerInterval) clearInterval(taskTimerInterval);
  taskTimerInterval = setInterval(() => {
    if (taskStartTime.value == null || taskFinalized.value) return;
    taskElapsedSeconds.value = Math.floor((Date.now() - taskStartTime.value) / 1000);
  }, 1000);
}

function stopTaskTimer() {
  if (taskTimerInterval) {
    clearInterval(taskTimerInterval);
    taskTimerInterval = null;
  }
}

function startAskUserCountdown() {
  askUserCountdown.value = 60;
  if (askUserCountdownTimer) clearInterval(askUserCountdownTimer);
  askUserCountdownTimer = setInterval(() => {
    askUserCountdown.value--;
    if (askUserCountdown.value <= 0 && askUserCountdownTimer) {
      clearInterval(askUserCountdownTimer);
      askUserCountdownTimer = null;
    }
  }, 1000);
}

function stopAskUserCountdown() {
  if (askUserCountdownTimer) {
    clearInterval(askUserCountdownTimer);
    askUserCountdownTimer = null;
  }
}

function playNotificationSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    /* ignore */
  }
}

function dismissFloatingTask() {
  taskSummary.value = "";
  taskStartTime.value = null;
  taskFinalized.value = false;
  taskSuccess.value = true;
  taskElapsedSeconds.value = 0;
  stopTaskTimer();
}

function submitTelegramLogin() {
  const v = telegramLoginValue.value.trim();
  window.electronAPI?.telegramLoginReply?.(v || "");
  telegramLoginStep.value = null;
  telegramLoginValue.value = "";
}

function dismissAskUser() {
  window.electronAPI?.askUserCancel?.();
  askUserInfo.value = null;
  askUserReply.value = "";
  stopAskUserCountdown();
}

function dismissFinalize() {
  showFinalizePopup.value = false;
  finalizeInfo.value = null;
  dismissFloatingTask();
}

async function authorizeGoogleApi() {
  try {
    const r = await window.electronAPI?.googleApiAuthorize?.();
    if (r?.ok) {
      alert("Google API authorized. Gmail and Calendar are now available in agent TS eval.");
    } else {
      alert(r?.error ?? "Google API authorization failed.");
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : "Google API authorization failed.");
  }
}

async function openPasswordsEditor() {
  showPasswordsEditor.value = true;
  passwordsError.value = "";
  await refreshPasswordsList();
}

async function refreshPasswordsList() {
  try {
    const list = (await window.electronAPI?.passwordsListFull?.()) ?? [];
    passwordsItems.value = list as typeof passwordsItems.value;
  } catch (err) {
    passwordsItems.value = [];
    passwordsError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function startAddPassword() {
  passwordsEditingId.value = null;
  passwordsForm.value = { description: "", type: "string", value: "" };
}

function startEditPassword(entry: (typeof passwordsItems.value)[0]) {
  passwordsEditingId.value = entry.uuid;
  passwordsForm.value = {
    description: entry.description,
    type: entry.type,
    value: entry.value,
  };
}

async function savePassword() {
  passwordsError.value = "";
  try {
    await window.electronAPI?.passwordsSet?.({
      description: passwordsForm.value.description,
      type: passwordsForm.value.type,
      value: passwordsForm.value.value,
      force: false,
      uuid: passwordsEditingId.value ?? undefined,
    });
    await refreshPasswordsList();
    passwordsEditingId.value = null;
    passwordsForm.value = { description: "", type: "string", value: "" };
  } catch (err) {
    passwordsError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

async function deletePassword(uuid: string) {
  if (!confirm("Delete this password?")) return;
  passwordsError.value = "";
  try {
    await window.electronAPI?.passwordsDelete?.(uuid);
    await refreshPasswordsList();
    if (passwordsEditingId.value === uuid) {
      passwordsEditingId.value = null;
      passwordsForm.value = { description: "", type: "string", value: "" };
    }
  } catch (err) {
    passwordsError.value = err instanceof Error ? err.message : "Failed to delete";
  }
}

async function openIdentitiesEditor() {
  showIdentitiesEditor.value = true;
  identitiesError.value = "";
  await refreshIdentitiesList();
}

async function refreshIdentitiesList() {
  try {
    const list = (await window.electronAPI?.identityList?.()) ?? [];
    identitiesItems.value = list as typeof identitiesItems.value;
  } catch (err) {
    identitiesItems.value = [];
    identitiesError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function startAddIdentity() {
  identitiesEditingId.value = null;
  identitiesForm.value = { name: "", identifier: "", trust_level: "normal", bus_ids_str: "" };
}

function startEditIdentity(entry: (typeof identitiesItems.value)[0]) {
  identitiesEditingId.value = entry.id;
  identitiesForm.value = {
    name: entry.name,
    identifier: entry.identifier,
    trust_level: entry.trust_level,
    bus_ids_str: entry.bus_ids.join(", "),
  };
}

async function saveIdentity() {
  identitiesError.value = "";
  const busIds = identitiesForm.value.bus_ids_str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    if (identitiesEditingId.value) {
      await window.electronAPI?.identityUpdate?.(identitiesEditingId.value, {
        name: identitiesForm.value.name,
        identifier: identitiesForm.value.identifier,
        trust_level: identitiesForm.value.trust_level,
        bus_ids: busIds,
      });
    } else {
      await window.electronAPI?.identityCreate?.({
        name: identitiesForm.value.name,
        identifier: identitiesForm.value.identifier,
        trust_level: identitiesForm.value.trust_level,
        bus_ids: busIds,
      });
    }
    await refreshIdentitiesList();
    identitiesEditingId.value = null;
    identitiesForm.value = { name: "", identifier: "", trust_level: "normal", bus_ids_str: "" };
  } catch (err) {
    identitiesError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

async function deleteIdentity(entry: (typeof identitiesItems.value)[0]) {
  if (!confirm(`Delete identity "${entry.name}"?`)) return;
  identitiesError.value = "";
  try {
    await window.electronAPI?.identityDelete?.(entry.id);
    await refreshIdentitiesList();
    if (identitiesEditingId.value === entry.id) {
      identitiesEditingId.value = null;
      identitiesForm.value = { name: "", identifier: "", trust_level: "normal", bus_ids_str: "" };
    }
  } catch (err) {
    identitiesError.value = err instanceof Error ? err.message : "Failed to delete";
  }
}

async function openIdentityNote(entry: (typeof identitiesItems.value)[0]) {
  identityNoteTarget.value = entry;
  identityNoteError.value = "";
  try {
    const ident = await window.electronAPI?.identityGet?.(entry.identifier);
    identityNoteContent.value = (ident && "note" in ident ? ident.note : "") ?? "";
  } catch (err) {
    identityNoteContent.value = "";
    identityNoteError.value = err instanceof Error ? err.message : "Failed to load";
  }
  showIdentityNoteEditor.value = true;
}

async function saveIdentityNote() {
  if (!identityNoteTarget.value) return;
  identityNoteError.value = "";
  try {
    await window.electronAPI?.identitySetNote?.(identityNoteTarget.value.identifier, identityNoteContent.value);
    showIdentityNoteEditor.value = false;
    identityNoteTarget.value = null;
  } catch (err) {
    identityNoteError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

const BUS_STATUS_POLL_MS = 2000;
let busStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let vmPollInterval: ReturnType<typeof setInterval> | null = null;

async function refreshBusStatusList() {
  try {
    const list = await window.electronAPI?.messageBusList?.() ?? [];
    busStatusList.value = list as { bus_id: string; description: string; is_connected: boolean }[];
  } catch {
    busStatusList.value = [];
  }
}

async function openBusStatuses() {
  showBusStatuses.value = true;
  await refreshBusStatusList();
}

function formatScheduleAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

function toDatetimeLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

async function openScheduleEditor() {
  showScheduleEditor.value = true;
  scheduleError.value = "";
  startAddSchedule();
  await refreshScheduleList();
}

async function refreshScheduleList() {
  try {
    const [list, startup] = await Promise.all([
      window.electronAPI?.scheduleList?.() ?? [],
      window.electronAPI?.scheduleGetStartup?.() ?? { title: "", instructions: "" },
    ]);
    scheduleItems.value = list;
    scheduleStartupTask.value = startup;
  } catch (err) {
    scheduleItems.value = [];
    scheduleStartupTask.value = null;
    scheduleError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function selectSchedule(s: { id: string; at: string; title: string; instructions: string }) {
  scheduleSelectedId.value = s.id;
  scheduleFormAt.value = s.id === ZERO_TASK_ID ? "" : toDatetimeLocal(s.at);
  scheduleFormTitle.value = s.title;
  scheduleFormInstructions.value = s.instructions;
  scheduleError.value = "";
}

function startAddSchedule() {
  scheduleSelectedId.value = null;
  const now = new Date();
  scheduleFormAt.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  scheduleFormTitle.value = "";
  scheduleFormInstructions.value = "";
  scheduleError.value = "";
}

async function saveSchedule() {
  const title = scheduleFormTitle.value.trim();
  const instructions = scheduleFormInstructions.value.trim();
  if (!title) {
    scheduleError.value = "Title is required";
    return;
  }
  if (scheduleSelectedId.value === ZERO_TASK_ID) {
    scheduleError.value = "";
    scheduleSaving.value = true;
    try {
      await window.electronAPI?.scheduleSetStartup?.({ title, instructions });
      await refreshScheduleList();
      scheduleSelectedId.value = ZERO_TASK_ID;
      scheduleFormTitle.value = title;
      scheduleFormInstructions.value = instructions;
    } catch (err) {
      scheduleError.value = err instanceof Error ? err.message : "Failed to save";
    } finally {
      scheduleSaving.value = false;
    }
    return;
  }
  const atVal = scheduleFormAt.value.trim();
  if (!atVal) {
    scheduleError.value = "Date/time is required";
    return;
  }
  const at = new Date(atVal).toISOString();
  if (isNaN(new Date(at).getTime())) {
    scheduleError.value = "Invalid date/time";
    return;
  }
  if (new Date(at).getTime() <= Date.now()) {
    scheduleError.value = "Schedule time must be in the future";
    return;
  }
  scheduleError.value = "";
  scheduleSaving.value = true;
  try {
    if (scheduleSelectedId.value) {
      await window.electronAPI?.scheduleUpdate?.(scheduleSelectedId.value, { at, title, instructions });
    } else {
      await window.electronAPI?.scheduleAdd?.(at, title, instructions);
    }
    await refreshScheduleList();
    startAddSchedule();
  } catch (err) {
    scheduleError.value = err instanceof Error ? err.message : "Failed to save";
  } finally {
    scheduleSaving.value = false;
  }
}

async function deleteSchedule() {
  if (!scheduleSelectedId.value || !confirm("Delete this schedule?")) return;
  scheduleError.value = "";
  scheduleSaving.value = true;
  try {
    await window.electronAPI?.scheduleDelete?.(scheduleSelectedId.value);
    await refreshScheduleList();
    startAddSchedule();
  } catch (err) {
    scheduleError.value = err instanceof Error ? err.message : "Failed to delete";
  } finally {
    scheduleSaving.value = false;
  }
}

const config = ref({
  aiProvider: "claude" as "claude" | "openrouter" | "codex",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  codexModel: "gpt-5.4-codex",
  userName: "",
  rootUserIdentifier: "",
  rootUserIdentifierDefined: true,
  enableMdParsing: false,
  setupMode: false,
});
const rootIdentifierWarningDismissed = ref(false);
const skipInitialTask = ref(false);

type VmInfo = { id: string; name: string; path: string; status: string; ramMb: number; diskGb: number };
const vms = ref<VmInfo[]>([]);
const vmMessage = ref("");
const vmMessageError = ref(false);
const vmCreateForm = ref({ isoPath: "", diskGb: 20, ramMb: 4096 });
const vmCreating = ref(false);
const vmRefreshing = ref(false);
const vmStarting = ref(false);

async function refreshVmList() {
  vmMessage.value = "";
  vmMessageError.value = false;
  vmRefreshing.value = true;
  try {
    const list = (await window.electronAPI?.vmList?.()) ?? [];
    vms.value = list as VmInfo[];
  } catch {
    vms.value = [];
  } finally {
    vmRefreshing.value = false;
  }
}

async function pickIso() {
  const r = await window.electronAPI?.vmPickIso?.();
  if (r?.ok && r.path) vmCreateForm.value.isoPath = r.path;
}

async function createVm() {
  vmMessage.value = "";
  vmMessageError.value = false;
  vmCreating.value = true;
  try {
    const r = await window.electronAPI?.vmCreate?.({
      isoPath: vmCreateForm.value.isoPath || undefined,
      diskGb: vmCreateForm.value.diskGb,
      ramMb: vmCreateForm.value.ramMb,
    });
    if (r?.ok) {
      await refreshVmList();
      vmCreateForm.value = { isoPath: "", diskGb: 20, ramMb: 4096 };
    } else {
      vmMessage.value = r?.error ?? "Failed to create VM";
      vmMessageError.value = true;
    }
  } catch (err) {
    vmMessage.value = err instanceof Error ? err.message : "Failed to create VM";
    vmMessageError.value = true;
  } finally {
    vmCreating.value = false;
  }
}

async function startVm(vmId: string) {
  vmMessage.value = "";
  vmMessageError.value = false;
  vmStarting.value = true;
  try {
    const r = await window.electronAPI?.vmStart?.(vmId);
    if (!r?.ok) {
      let msg = r?.error ?? "Failed to start VM";
      if (msg.includes("com.apple.security.virtualization")) {
        msg = "YaaiaVM needs the virtualization entitlement. Run: npm run build:vm (from yaaia-app), then restart the app.";
      }
      vmMessage.value = msg;
      vmMessageError.value = true;
    }
    await refreshVmList();
  } finally {
    vmStarting.value = false;
  }
}

async function stopVm(vmId: string) {
  vmMessage.value = "";
  vmMessageError.value = false;
  const r = await window.electronAPI?.vmStop?.(vmId);
  if (!r?.ok) {
    vmMessage.value = r?.error ?? "Failed to stop VM";
    vmMessageError.value = true;
  }
  await refreshVmList();
}

async function showConsoleVm(vmId: string) {
  await window.electronAPI?.vmShowConsole?.(vmId);
}

async function deleteVm(vmId: string) {
  if (!confirm("Delete this VM? This cannot be undone.")) return;
  vmMessage.value = "";
  vmMessageError.value = false;
  const r = await window.electronAPI?.vmDelete?.(vmId);
  if (!r?.ok) {
    vmMessage.value = r?.error ?? "Failed to delete VM";
    vmMessageError.value = true;
  }
  await refreshVmList();
}

const codexAuthenticated = ref(false);
const codexLoggingIn = ref(false);

async function refreshCodexAuthStatus() {
  try {
    const r = await window.electronAPI?.codexAuthStatus?.();
    codexAuthenticated.value = !!r?.authenticated;
  } catch {
    codexAuthenticated.value = false;
  }
}

async function codexLogin() {
  codexLoggingIn.value = true;
  try {
    const r = await window.electronAPI?.codexLogin?.();
    if (r?.ok) {
      codexAuthenticated.value = true;
    } else {
      alert(r?.error ?? "Codex login failed");
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    codexLoggingIn.value = false;
  }
}

async function codexLogout() {
  await window.electronAPI?.codexLogout?.();
  codexAuthenticated.value = false;
}

const agentReady = ref(false);
const starting = ref(false);
const startupSteps = ref<string[]>([]);
const startupMilestones = ["Ready", "Agent ready"];
const messages = ref<ChatMessage[]>([]);
const rootHistoryTotal = ref(0);
const rootHistoryLoadedCount = ref(0);
const HISTORY_PAGE_SIZE = 100;
const inputText = ref("");
const streaming = ref(false);
const streamBuffer = ref("");
const sending = ref(false);
const messagesRef = ref<HTMLElement | null>(null);
const scrollAnchor = ref<HTMLElement | null>(null);
const messageTextareaRef = ref<HTMLTextAreaElement | null>(null);

/** When true, new content triggers auto-scroll. Set by textarea focus/blur. */
const textareaFocused = ref(false);

function doScrollToBottom() {
  scrollAnchor.value?.scrollIntoView({ behavior: "auto", block: "end" });
}

/** Scroll to bottom only when textarea is focused (user is composing). */
function scrollToBottomIfFollowing() {
  if (!textareaFocused.value) return;
  nextTick(() => {
    requestAnimationFrame(() => doScrollToBottom());
  });
}

/** Force scroll to bottom (e.g. after send). */
function scrollToBottomAlways() {
  nextTick(() => {
    requestAnimationFrame(() => doScrollToBottom());
  });
}
const askUserInfo = ref<{ clarification: string; assessment: string; attempt: number } | null>(null);
const askUserReply = ref("");
const telegramLoginStep = ref<"phone" | "code" | "password" | null>(null);
const telegramLoginValue = ref("");
const telegramLoginLabel = computed(() => {
  if (telegramLoginStep.value === "phone") return "Enter your phone number (e.g. +1234567890):";
  if (telegramLoginStep.value === "code") return "Enter the verification code sent to your phone:";
  if (telegramLoginStep.value === "password") return "Enter your 2FA password:";
  return "";
});
const telegramLoginPlaceholder = computed(() => {
  if (telegramLoginStep.value === "phone") return "+1234567890";
  if (telegramLoginStep.value === "code") return "12345";
  if (telegramLoginStep.value === "password") return "Password";
  return "";
});
const showFinalizePopup = ref(false);
const finalizeInfo = ref<{ is_successful: boolean } | null>(null);
const pendingReportForNextMessage = ref(false);

const taskSummary = ref("");
const taskStartTime = ref<number | null>(null);
const taskFinalized = ref(false);
const taskSuccess = ref(true);
const taskElapsedSeconds = ref(0);
let taskTimerInterval: ReturnType<typeof setInterval> | null = null;

const askUserCountdown = ref(60);

// Passwords Editor
const showPasswordsEditor = ref(false);
const passwordsItems = ref<
  Array<{ uuid: string; description: string; type: "string" | "totp"; value: string }>
>([]);
const passwordsError = ref("");
const passwordsEditingId = ref<string | null>(null);
const passwordsForm = ref({
  description: "",
  type: "string" as "string" | "totp",
  value: "",
});

// Identities Editor
const showIdentitiesEditor = ref(false);
const showIdentityNoteEditor = ref(false);
const identitiesItems = ref<
  Array<{ id: string; name: string; identifier: string; trust_level: "root" | "normal"; bus_ids: string[] }>
>([]);
const identitiesError = ref("");
const identitiesEditingId = ref<string | null>(null);
const identitiesForm = ref({
  name: "",
  identifier: "",
  trust_level: "normal" as "root" | "normal",
  bus_ids_str: "",
});
const identityNoteTarget = ref<{ id: string; name: string; identifier: string } | null>(null);
const identityNoteContent = ref("");
const identityNoteError = ref("");

// Schedule Editor
const ZERO_TASK_ID = "zero";
const showScheduleEditor = ref(false);
const showBusStatuses = ref(false);
const busStatusList = ref<{ bus_id: string; description: string; is_connected: boolean }[]>([]);
const scheduleItems = ref<Array<{ id: string; at: string; title: string; instructions: string; created_at: string }>>([]);
const scheduleStartupTask = ref<{ title: string; instructions: string } | null>(null);
const scheduleSelectedId = ref<string | null>(null);
const scheduleListWithZero = computed(() => {
  const zero = scheduleStartupTask.value;
  if (!zero) return scheduleItems.value;
  const zeroItem = { id: ZERO_TASK_ID, at: "", title: zero.title, instructions: zero.instructions, created_at: "" };
  return [zeroItem, ...scheduleItems.value];
});
const scheduleFormAt = ref("");
const scheduleFormTitle = ref("");
const scheduleFormInstructions = ref("");
const scheduleError = ref("");
const scheduleSaving = ref(false);

let askUserCountdownTimer: ReturnType<typeof setInterval> | null = null;

let streamUnsub: (() => void) | undefined;
let askUserUnsub: (() => void) | undefined;
let askUserCloseUnsub: (() => void) | undefined;
let taskStartUnsub: (() => void) | undefined;
let finalizeUnsub: (() => void) | undefined;
let startupProgressUnsub: (() => void) | undefined;
let startupProgressResetUnsub: (() => void) | undefined;
let agentMessageUnsub: (() => void) | undefined;
let scheduleTriggerUnsub: (() => void) | undefined;
let agentDrainUnsub: (() => void) | undefined;
let telegramMessageUnsub: (() => void) | undefined;
let emailMessageUnsub: (() => void) | undefined;
let telegramLoginUnsub: (() => void) | undefined;

/** Queued messages when agent is busy; drained and sent together when agent finishes. */
const messageQueue = ref<{ msg: string; bus_id: string; timestamp: string }[]>([]);

/** Debounce timer for batching incoming messages (Telegram/Email) into one agent request. */
let drainDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const DRAIN_DEBOUNCE_MS = 1000;

const streamingParsed = computed(() => parseStream(streamBuffer.value));

const enableMdParsing = computed(() => config.value.enableMdParsing ?? false);

const messagesWithPrettified = computed(() =>
  messages.value.map((msg) => ({
    ...msg,
    _prettified: prettifyChatContent(msg.content, enableMdParsing.value),
  }))
);

const streamingParsedWithPrettified = computed(() => {
  const { parts, tail } = streamingParsed.value;
  return {
    parts: parts.map((p) => ({
      ...p,
      _prettified: prettifyChatContent(p.content, enableMdParsing.value),
    })),
    tailPrettified: prettifyChatContent(tail, enableMdParsing.value),
  };
});

function queueMessage(msg: string, bus_id: string): void {
  messageQueue.value.push({ msg, bus_id, timestamp: new Date().toISOString() });
}

function buildQueuedPayload(): string {
  if (messageQueue.value.length === 0) return "";
  const lines = messageQueue.value.map((q) => `${q.bus_id}:${q.msg}`);
  messageQueue.value = [];
  return lines.join("\n");
}

/** Schedule a debounced drain so multiple incoming messages (e.g. when agent was offline) are batched into one request. */
function scheduleDrain(): void {
  if (!agentReady.value) return;
  if (drainDebounceTimer) clearTimeout(drainDebounceTimer);
  drainDebounceTimer = setTimeout(async () => {
    drainDebounceTimer = null;
    await drainQueueAndSend();
  }, DRAIN_DEBOUNCE_MS);
}

async function drainQueueAndSend(): Promise<void> {
  const payload = buildQueuedPayload();
  if (!payload) return;
  sending.value = true;
  streaming.value = true;
  streamBuffer.value = "";
  try {
    await window.electronAPI?.agentSendMessage?.(payload, [], "root");
    const { parts, tail } = parseStream(streamBuffer.value);
    for (const p of parts) messages.value.push(p);
    const finalContent = tail.trim();
    if (finalContent) {
      messages.value.push({ role: "assistant", content: finalContent });
    }
  } catch (err) {
    const { parts, tail } = parseStream(streamBuffer.value);
    for (const p of parts) messages.value.push(p);
    const msg = err instanceof Error ? err.message : String(err);
    const content = tail.trim() ? `${tail.trim()}\n\n**Error:** ${msg}` : `Error: ${msg}`;
    messages.value.push({ role: "assistant", content, isError: true });
  } finally {
    sending.value = false;
    streaming.value = false;
    streamBuffer.value = "";
    await refreshMessagesFromRoot();
    scrollToBottomAlways();
    await drainQueueAndSend();
  }
}

type RootHistoryMessage = { role: string; content: string; user_id?: number; user_name?: string; bus_id?: string; timestamp?: string };

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" });
}

function rootHistoryToMessages(hist: RootHistoryMessage[]): ChatMessage[] {
  return hist.map((m) => {
    const role = m.role as "user" | "assistant";
    const busId = m.bus_id;
    const userName = m.user_name ?? "";
    let content = m.content ?? "";
    const timestamp = m.timestamp;
    if (role === "user" && busId && busId !== "root") {
      let emoji = "📱";
      if (busId.startsWith("email-")) emoji = "📧";
      else if (busId.startsWith("google-")) emoji = "📅";
      content = `${emoji} **${busId}** (${userName}): ${content}`;
      return { role, content, timestamp, type: undefined, isTelegram: true };
    }
    return { role, content, timestamp, type: role === "assistant" ? "content" : undefined };
  });
}

async function refreshMessagesFromRoot(): Promise<void> {
  try {
    const sliceRes = (await window.electronAPI?.messageBusGetHistorySlice?.("root", HISTORY_PAGE_SIZE, 0)) ?? {
      messages: [],
      total: 0,
    };
    const rootHistory = (sliceRes.messages ?? []) as RootHistoryMessage[];
    const fromHistory = rootHistoryToMessages(rootHistory);
    rootHistoryTotal.value = sliceRes.total ?? 0;
    rootHistoryLoadedCount.value = fromHistory.length;
    messages.value = fromHistory;
  } catch {
    /* ignore */
  }
}

async function loadOlderMessages(): Promise<void> {
  const total = rootHistoryTotal.value;
  const loaded = rootHistoryLoadedCount.value;
  if (loaded >= total) return;
  const offset = Math.max(1, total - loaded - HISTORY_PAGE_SIZE + 1);
  try {
    const sliceRes = (await window.electronAPI?.messageBusGetHistorySlice?.("root", HISTORY_PAGE_SIZE, offset)) ?? {
      messages: [],
      total: 0,
    };
    const olderHistory = (sliceRes.messages ?? []) as RootHistoryMessage[];
    const older = rootHistoryToMessages(olderHistory);
    if (older.length === 0) return;
    rootHistoryLoadedCount.value += older.length;
    const memCount = messages.value.filter((m) => m.type === "memory").length;
    messages.value = [
      ...messages.value.slice(0, memCount),
      ...older,
      ...messages.value.slice(memCount),
    ];
  } catch {
    /* ignore */
  }
}

async function startChat() {
  starting.value = true;
  try {
    const plainConfig = JSON.parse(JSON.stringify(config.value)) as Record<string, unknown>;
    plainConfig.skipInitialTask = skipInitialTask.value;
    const result = await window.electronAPI?.startChat?.(plainConfig);
    if (result?.ok) {
      const cfg = await window.electronAPI?.getConfig?.();
      if (cfg) config.value = { ...config.value, ...cfg };
      streamBuffer.value = "";
      stopTaskTimer();
      taskSummary.value = "";
      taskStartTime.value = null;
      taskFinalized.value = false;
      taskSuccess.value = true;
      taskElapsedSeconds.value = 0;
      showFinalizePopup.value = false;
      finalizeInfo.value = null;
      pendingReportForNextMessage.value = false;
      agentReady.value = true;
      await refreshMessagesFromRoot();
      await nextTick();
      messageTextareaRef.value?.focus();
    } else {
      alert(result?.message ?? "Failed to start");
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    starting.value = false;
  }
}

async function openVmSerialConsole() {
  const r = await window.electronAPI?.vmOpenSerialConsole?.();
  if (!r?.ok) {
    alert(r?.error ?? "Failed to open VM serial console");
  }
}

async function openStorageFolder() {
  await window.electronAPI?.openStorageFolder?.();
}

async function exitChat() {
  if (drainDebounceTimer) {
    clearTimeout(drainDebounceTimer);
    drainDebounceTimer = null;
  }
  messageQueue.value = [];
  await window.electronAPI?.stopChat?.();
  agentReady.value = false;
}

function stopAgent() {
  if (sending.value) window.electronAPI?.agentAbort?.();
}

function buildHistory(msgs: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  const include = (x: ChatMessage) =>
    x.type === "memory"
      ? false
      : x.role === "user" ||
      (x.role === "assistant" &&
        (x.type === "assessment" || x.type === "clarification" || x.type === "content" || (x.content && x.type !== "tool_call" && x.type !== "tool_running")));
  const filtered = msgs.filter(include);
  for (const m of filtered) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else {
      const content = m.type === "assessment" ? `**Assessment:** ${m.content}\n\n` : m.type === "clarification" ? `**Clarification:** ${m.content}\n\n` : m.content + (m.content ? "\n\n" : "");
      if (out.length > 0 && out[out.length - 1].role === "assistant") out[out.length - 1].content += content;
      else out.push({ role: "assistant", content });
    }
  }
  return out;
}

async function send() {
  const text = inputText.value.trim();
  if (!text) return;

  if (sending.value) {
    inputText.value = "";
    const queuedMsg = `root:${text}`;
    messages.value.push({ role: "user", content: queuedMsg, timestamp: new Date().toISOString() });
    window.electronAPI?.agentQueueMessage?.(queuedMsg);
    scrollToBottomAlways();
    return;
  }

  inputText.value = "";
  const userMsg = `root:${text}`;
  messages.value.push({ role: "user", content: userMsg, timestamp: new Date().toISOString() });
  textareaFocused.value = true;
  sending.value = true;
  streaming.value = true;
  streamBuffer.value = "";
  try {
    const history = buildHistory(messages.value.slice(0, -1));
    const reply = await window.electronAPI?.agentSendMessage?.(userMsg, history);
    const { parts, tail } = parseStream(streamBuffer.value);
    for (const p of parts) messages.value.push(p);
    let finalContent: string;
    if (reply === "Stopped by user.") {
      finalContent = (tail.trim() ? tail.trim() + "\n\n" : "") + "_Stopped by user._";
    } else if (reply) {
      finalContent = reply;
    } else {
      finalContent = tail.trim();
    }
    if (finalContent) {
      const isReport = pendingReportForNextMessage.value;
      if (isReport) pendingReportForNextMessage.value = false;
      messages.value.push({ role: "assistant", content: finalContent, isReport: isReport || undefined });
    }
  } catch (err) {
    const { parts, tail } = parseStream(streamBuffer.value);
    for (const p of parts) messages.value.push(p);
    const msg = err instanceof Error ? err.message : String(err);
    const content = tail.trim() ? `${tail.trim()}\n\n**Error:** ${msg}` : `Error: ${msg}`;
    messages.value.push({ role: "assistant", content, isError: true });
  } finally {
    sending.value = false;
    streaming.value = false;
    streamBuffer.value = "";
    await refreshMessagesFromRoot();
    scrollToBottomAlways();
    await drainQueueAndSend();
  }
}

function submitAskUserReply() {
  const reply = askUserReply.value.trim();
  window.electronAPI?.askUserReply?.(reply || "(no message)");
  dismissAskUser();
}

async function viewRecipe() {
  await window.electronAPI?.recipeView?.();
}

async function saveRecipe() {
  const path = await window.electronAPI?.recipeSave?.();
  if (path) alert(`Saved to ${path}`);
}

async function loadRecipe() {
  const r = await window.electronAPI?.recipeLoad?.();
  if (r?.ok && r.markdown) {
    const instructions = prompt("Optional custom instructions for this recipe:");
    const msg = instructions
      ? `Follow this recipe with my adjustments:\n\n${instructions}\n\n---\n\n${r.markdown}`
      : `Follow this recipe:\n\n${r.markdown}`;
    inputText.value = msg;
  } else if (r?.error) {
    alert(r.error);
  }
}

watch(streamBuffer, () => scrollToBottomIfFollowing());
watch(messages, () => scrollToBottomIfFollowing(), { deep: true });

watch(() => config.value.aiProvider, (provider) => {
  if (provider === "codex") refreshCodexAuthStatus();
});
watch(showBusStatuses, (open) => {
  if (busStatusPollTimer) {
    clearInterval(busStatusPollTimer);
    busStatusPollTimer = null;
  }
  if (open) {
    busStatusPollTimer = setInterval(refreshBusStatusList, BUS_STATUS_POLL_MS);
  }
});

onMounted(async () => {
  const cfg = await window.electronAPI?.getConfig?.();
  if (cfg) config.value = { ...config.value, ...cfg };
  await refreshCodexAuthStatus();
  await refreshVmList();
  // Poll VM list when empty (YaaiaVM may still be starting)
  let pollCount = 0;
  vmPollInterval = setInterval(() => {
    if (vms.value.length > 0 || pollCount >= 8) {
      if (vmPollInterval) {
        clearInterval(vmPollInterval);
        vmPollInterval = null;
      }
      return;
    }
    pollCount++;
    refreshVmList();
  }, 2000);

  streamUnsub = window.electronAPI?.onAgentStreamChunk?.((chunk) => {
    streamBuffer.value += chunk;
    scrollToBottomIfFollowing();
  });

  agentMessageUnsub = window.electronAPI?.onAgentMessage?.((content) => {
    messages.value.push({ role: "user", content, timestamp: new Date().toISOString() });
    scrollToBottomAlways();
  });

  telegramLoginUnsub = window.electronAPI?.onTelegramLoginRequest?.((info) => {
    telegramLoginStep.value = info.step;
    telegramLoginValue.value = "";
  });

  agentDrainUnsub = window.electronAPI?.onAgentDrain?.((payload) => {
    if (sending.value) return;
    sending.value = true;
    streaming.value = true;
    streamBuffer.value = "";
    window.electronAPI
      ?.agentSendMessage?.(payload ?? "", [], "root")
      ?.then((reply) => {
        const { parts, tail } = parseStream(streamBuffer.value);
        for (const p of parts) messages.value.push(p);
        const finalContent = reply === "Stopped by user."
          ? (tail.trim() ? tail.trim() + "\n\n" : "") + "_Stopped by user._"
          : reply || tail.trim();
        if (finalContent) messages.value.push({ role: "assistant", content: finalContent, timestamp: new Date().toISOString() });
      })
      ?.catch((err) => {
        const { parts, tail } = parseStream(streamBuffer.value);
        for (const p of parts) messages.value.push(p);
        const content = tail.trim() ? `${tail.trim()}\n\n**Error:** ${err}` : `Error: ${err}`;
        messages.value.push({ role: "assistant", content, isError: true });
      })
      ?.finally(async () => {
        sending.value = false;
        streaming.value = false;
        streamBuffer.value = "";
        await refreshMessagesFromRoot();
        scrollToBottomAlways();
        await drainQueueAndSend();
      });
  });

  scheduleTriggerUnsub = window.electronAPI?.onScheduleTrigger?.((payload) => {
    const msg = typeof payload === "string" ? payload : payload.msg;
    let displayContent = "⏰ **Scheduled task**";
    if (typeof msg === "string" && msg.includes(":")) {
      const colonIdx = msg.indexOf(":");
      const content = msg.slice(colonIdx + 1).trim();
      if (content) displayContent = `⏰ **Scheduled task**\n\n${content}`;
    } else {
      try {
        const parsed = JSON.parse(msg);
        if (typeof parsed?.content === "string" && parsed.content.trim()) {
          displayContent = `⏰ **Scheduled task**\n\n${parsed.content}`;
        }
      } catch {
        /* use default */
      }
    }
    messages.value.push({ role: "user", content: displayContent, isTelegram: true, timestamp: new Date().toISOString() });
    scrollToBottomAlways();
  });

  telegramMessageUnsub = window.electronAPI?.onTelegramMessage?.((payload) => {
    const incomingLabel = `📱 **Telegram** (${payload.user_name}): ${payload.content}`;
    const ts = (payload as { timestamp?: string }).timestamp ?? new Date().toISOString();
    messages.value.push({ role: "user", content: incomingLabel, timestamp: ts, isTelegram: true });
    scrollToBottomAlways();
  });

  emailMessageUnsub = window.electronAPI?.onEmailMessage?.((payload) => {
    const preview = payload.content.length > 300 ? payload.content.slice(0, 300) + "…" : payload.content;
    const incomingLabel = `📧 **Email** (${payload.user_name}): ${preview}`;
    const ts = (payload as { timestamp?: string }).timestamp ?? new Date().toISOString();
    messages.value.push({ role: "user", content: incomingLabel, timestamp: ts, isTelegram: true });
    scrollToBottomAlways();
  });

  askUserUnsub = window.electronAPI?.onAskUserPopup?.((info) => {
    playNotificationSound();
    askUserInfo.value = info;
    askUserReply.value = "";
    startAskUserCountdown();
  });
  askUserCloseUnsub = window.electronAPI?.onAskUserPopupClose?.(() => {
    dismissAskUser();
  });

  taskStartUnsub = window.electronAPI?.onTaskStart?.((info) => {
    taskSummary.value = info.summary || "";
    taskStartTime.value = Date.now();
    taskFinalized.value = false;
    taskElapsedSeconds.value = 0;
    startTaskTimer();
  });

  finalizeUnsub = window.electronAPI?.onFinalizeTaskPopup?.((info) => {
    playNotificationSound();
    taskFinalized.value = true;
    taskSuccess.value = info.is_successful;
    stopTaskTimer();
    if (taskStartTime.value != null) {
      taskElapsedSeconds.value = Math.floor((Date.now() - taskStartTime.value) / 1000);
    }
    showFinalizePopup.value = true;
    finalizeInfo.value = info;
  });

  startupProgressResetUnsub = window.electronAPI?.onStartupProgressReset?.(() => {
    startupSteps.value = [];
  });
  startupProgressUnsub = window.electronAPI?.onStartupProgress?.((step) => {
    const prev = startupSteps.value;
    const last = prev[prev.length - 1];
    const isSubstep =
      last &&
      (last === "Preparing storage..." || last.startsWith("Indexing") || last.includes("%") || /^\d+\/\d+/.test(last));
    const isMilestone = startupMilestones.includes(step);
    if (isSubstep && !isMilestone && step !== last) {
      startupSteps.value = [...prev.slice(0, -1), step];
    } else {
      startupSteps.value = [...prev, step].slice(-15);
    }
  });
});

onUnmounted(() => {
  if (busStatusPollTimer) {
    clearInterval(busStatusPollTimer);
    busStatusPollTimer = null;
  }
  if (vmPollInterval) {
    clearInterval(vmPollInterval);
    vmPollInterval = null;
  }
  scrollCleanup?.();
  streamUnsub?.();
  askUserUnsub?.();
  askUserCloseUnsub?.();
  taskStartUnsub?.();
  finalizeUnsub?.();
  startupProgressUnsub?.();
  startupProgressResetUnsub?.();
  agentMessageUnsub?.();
  scheduleTriggerUnsub?.();
  agentDrainUnsub?.();
  telegramMessageUnsub?.();
  emailMessageUnsub?.();
  telegramLoginUnsub?.();
  stopAskUserCountdown();
  stopTaskTimer();
});
</script>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.header {
  flex-shrink: 0;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #333;
}

.header h1 {
  margin: 0;
  font-size: 1.5rem;
}

.header h1 .version {
  font-size: 0.7em;
  font-weight: 400;
  opacity: 0.7;
}

.error {
  color: #f85149;
  margin: 0.5rem 0 0;
}

.main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 1rem;
  padding: 1rem;
  padding-right: 11rem;
  /* space for fixed sidebar */
  overflow: hidden;
}

.config {
  flex: 1;
  min-width: 0;
}

.config .field {
  margin-bottom: 1rem;
}

.codex-auth-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.codex-status {
  color: #3fb950;
}

.codex-status.muted {
  color: #8b949e;
}

.vm-section {
  padding: 0.75rem;
  background: #161b22;
  border-radius: 8px;
  border: 1px solid #30363d;
}

.vm-message {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

.vm-message.error {
  color: #f85149;
}

.vm-create-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.vm-create-form .field-inline {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.vm-create-form .field-inline label {
  min-width: 5rem;
  margin-bottom: 0;
}

.vm-create-form .field-inline input {
  flex: 1;
}

.vm-create-form .field-inline input.iso-path {
  flex: 1;
  cursor: default;
}

.vm-create-form .field-inline input[type="number"] {
  width: 6rem;
  flex: none;
}

.vm-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.vm-actions .vm-info {
  flex: 1;
  min-width: 12rem;
  font-size: 0.9rem;
  color: #8b949e;
}

.config label {
  display: block;
  margin-bottom: 0.25rem;
  color: #8b949e;
}

.config input,
.config select {
  width: 100%;
  padding: 0.5rem;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #e6edf3;
}

.startup-progress {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
  font-size: 0.9rem;
}

.startup-progress li {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
  color: #8b949e;
}

.startup-progress li.done {
  color: #3fb950;
}

.startup-progress .check {
  width: 1.2em;
  font-weight: bold;
}

.chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.root-identifier-warning {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  margin-bottom: 0.5rem;
  background: #2a2518;
  border: 1px solid #3d3520;
  border-radius: 6px;
  font-size: 0.9rem;
  color: #e6edf3;
}

.root-identifier-warning-close {
  flex-shrink: 0;
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border: none;
  background: transparent;
  color: #8b949e;
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  border-radius: 4px;
}

.root-identifier-warning-close:hover {
  background: #3d3520;
  color: #e6edf3;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 1rem;
  background: #0d1117;
  border-radius: 8px;
  margin-bottom: 1rem;
}

.msg {
  margin-bottom: 1rem;
  padding: 0.75rem;
  border-radius: 6px;
}

.msg.user {
  background: #1a2d3d;
  border: 1px solid #2d3d4d;
  margin-left: 2rem;
}

.msg.assistant {
  background: #161b22;
  margin-right: 2rem;
}

.msg.assistant.assessment {
  background: #2a2518;
  border: 1px solid #3d3520;
}

.msg.assistant.clarification {
  background: #1e1a2a;
  border: 1px solid #2d2840;
}

.msg.assistant.content,
.msg.assistant:not(.assessment):not(.clarification):not(.report) {
  background: #1a1f26;
  border: 1px solid #252b33;
}

.msg.report {
  background: #1a2a1e;
  border: 1px solid #2d4035;
}

.msg-timestamp {
  display: block;
  font-size: 0.7rem;
  color: #6e7681;
  margin-bottom: 0.25rem;
}

.msg-type-label {
  display: block;
  font-size: 0.75rem;
  color: #8b949e;
  margin-bottom: 0.25rem;
}

.msg-markdown :deep(pre) {
  background: #21262d;
  padding: 0.5rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.85rem;
}

.msg-markdown :deep(details) {
  margin-top: 0.25rem;
}

.msg-markdown :deep(.msg-code-accordion) {
  margin-top: 0.5rem;
}

.msg-markdown :deep(.msg-code-accordion summary) {
  cursor: pointer;
  color: #8b949e;
  font-size: 0.85rem;
}

.msg-text {
  white-space: pre-wrap;
}

.msg-error,
.msg.error .msg-text {
  color: #f85149;
}

.chat-load-older {
  margin-bottom: 1rem;
}

.chat-placeholder {
  color: #8b949e;
  padding: 1rem;
}

.chat-input {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.chat-input-row {
  display: flex;
  gap: 0.5rem;
  align-items: flex-end;
}

.chat-input textarea {
  flex: 1;
  padding: 0.5rem;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #e6edf3;
  resize: none;
}

.chat-scroll-hint {
  font-size: 0.75rem;
  color: #8b949e;
  margin: 0;
}

.sidebar {
  position: fixed;
  top: 5rem;
  /* below header */
  right: 1rem;
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.btn {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 0.9rem;
}

.btn.primary {
  background: #238636;
  color: white;
}

.btn.primary:hover:not(:disabled) {
  background: #2ea043;
}

.btn.secondary {
  background: #21262d;
  color: #e6edf3;
  border: 1px solid #30363d;
}

.btn.secondary:hover {
  background: #30363d;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ask-user-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.ask-user-modal {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 1.5rem;
  min-width: 400px;
}

.ask-user-modal h3 {
  margin-top: 0;
}

.ask-user-modal textarea {
  width: 100%;
  padding: 0.5rem;
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #e6edf3;
  margin: 1rem 0;
  resize: vertical;
}

.ask-user-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.ask-user-assessment,
.ask-user-clarification {
  margin: 0.5rem 0;
}

.ask-user-countdown {
  color: #58a6ff;
  font-size: 0.9rem;
  margin: 0.5rem 0;
}

.report-block {
  margin-top: 1rem;
  padding: 0.75rem;
  background: #1a2a1e;
  border-radius: 6px;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #2d4035;
}

.report-block .report-content {
  margin-top: 0.5rem;
}

.finalize-modal.finalize-failed {
  border-color: #6a4a4a;
  background: #1e1616;
}

.finalize-modal.finalize-failed h3 {
  color: #b86a6a;
}

.floating-task {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  background: #1e2a3a;
  border: 1px solid #3a5a7a;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  z-index: 500;
  font-size: 0.9rem;
}

.floating-task-name {
  color: #e0e0e0;
  font-weight: 500;
}

.floating-task-timer {
  color: #6ab7ff;
  font-variant-numeric: tabular-nums;
}

.floating-task.finalized {
  border-color: #4a6a4a;
  background: #1e2a1e;
}

.floating-task.finalized .floating-task-timer {
  color: #6ab86a;
}

.floating-task.finalized.failed {
  border-color: #6a4a4a;
  background: #2a1e1e;
}

.floating-task.finalized.failed .floating-task-timer {
  color: #b86a6a;
}

.editor-overlay {
  z-index: 200;
}

.bus-status-modal {
  min-width: 360px;
  max-width: 560px;
}

.bus-status-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.bus-status-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.9rem;
}

.bus-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.bus-status-dot.online {
  background: #3fb950;
}

.bus-status-dot.offline {
  background: #8b949e;
}

.bus-status-name {
  flex: 1;
  color: #e6edf3;
}

.bus-status-id {
  color: #8b949e;
  font-size: 0.8rem;
  font-family: monospace;
}

.bus-status-label {
  font-size: 0.8rem;
  font-weight: 600;
  min-width: 44px;
  text-align: right;
}

.bus-status-label.online {
  color: #3fb950;
}

.bus-status-label.offline {
  color: #8b949e;
}

.editor-modal {
  max-width: 640px;
  max-height: 85vh;
  overflow: auto;
  min-width: 420px;
}

.editor-error {
  color: #f85149;
  font-size: 0.9rem;
  margin: 0 0 0.75rem;
}

.editor-hint {
  color: #8b949e;
  font-size: 0.85rem;
  margin: 0 0 0.5rem;
}

.editor-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.editor-form input {
  width: 100%;
  box-sizing: border-box;
}

.editor-input {
  padding: 0.5rem 0.75rem;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #e6edf3;
  font-size: 0.95rem;
}

.editor-input:focus {
  outline: none;
  border-color: #58a6ff;
}

.editor-form-actions {
  display: flex;
  gap: 0.5rem;
}

.editor-list {
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #0d1117;
  margin-bottom: 1rem;
}

.editor-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #21262d;
  gap: 0.75rem;
}

.editor-row:last-child {
  border-bottom: none;
}

.editor-row-fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.editor-row-desc {
  font-weight: 600;
  color: #58a6ff;
}

.editor-row-factor,
.editor-row-type {
  color: #8b949e;
}

.editor-row-value {
  word-break: break-all;
  color: #e6edf3;
}

.editor-row-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  background: #238636;
  color: #fff;
  border-radius: 4px;
  margin-left: 0.25rem;
}

.editor-row-actions {
  flex-shrink: 0;
  display: flex;
  gap: 0.35rem;
}

.editor-modal-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

.btn.small {
  padding: 0.35rem 0.6rem;
  font-size: 0.85rem;
}

.schedule-editor-modal {
  max-width: 700px;
}

.schedule-editor-layout {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  min-height: 200px;
}

.schedule-editor-list {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border: 1px solid #333;
  border-radius: 4px;
  padding: 0.25rem;
}

.schedule-editor-item {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
  border-radius: 4px;
}

.schedule-editor-item:hover {
  background: #21262d;
}

.schedule-editor-item.selected {
  background: #1a3a5c;
  color: #58a6ff;
}

.schedule-item-title {
  font-weight: 500;
}

.schedule-item-at {
  font-size: 0.75rem;
  color: #8b949e;
  margin-top: 0.2rem;
}

.schedule-editor-item.schedule-zero .schedule-item-at {
  color: #58a6ff;
  font-style: italic;
}

.schedule-editor-form {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.editor-textarea {
  flex: 1;
  min-height: 200px;
  padding: 0.5rem 0.75rem;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #e6edf3;
  font-family: inherit;
  font-size: 0.9rem;
  resize: vertical;
}

.editor-textarea:focus {
  outline: none;
  border-color: #58a6ff;
}
</style>
