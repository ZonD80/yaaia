<template>
  <div class="app" @click="onAppLinkClick">
    <header class="header">
      <h1>YAAIA <span class="version">v{{ appVersion }}</span></h1>
      <p v-if="agentBrowserError" class="error">{{ agentBrowserError }}</p>
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
        <div class="field">
          <label>Telegram App ID</label>
          <input v-model="config.telegramAppId" placeholder="e.g. 12345678" />
        </div>
        <div class="field">
          <label>Telegram API Hash</label>
          <input type="password" v-model="config.telegramApiHash" placeholder="e.g. abc123..." />
        </div>
        <div class="field">
          <label>Your name (root bus)</label>
          <input v-model="config.userName" placeholder="e.g. Alice" />
        </div>
        <ul v-if="startupSteps.length" class="startup-progress">
          <li v-for="(step, i) in startupSteps" :key="i" :class="{ done: i < startupSteps.length - 1 || startupMilestones.includes(step) }">
            <span class="check">{{ (i < startupSteps.length - 1 || startupMilestones.includes(step)) ? "✓" : "" }}</span>
            <span class="text">{{ step }}</span>
          </li>
        </ul>
        <button class="btn primary" @click="startChat" :disabled="starting">
          {{ starting ? "Starting..." : "Start chat" }}
        </button>
      </section>
      <section class="chat" v-else>
        <div class="chat-messages" ref="messagesRef">
          <div v-if="messages.length === 0" class="chat-placeholder">Agent is ready. Type your message below.</div>
          <div v-for="(msg, i) in messages" :key="i" :class="['msg', msg.role, { error: msg.isError, report: msg.isReport }, msg.type]">
            <template v-if="msg.role === 'user'">
              <span v-if="msg.injected" class="msg-type-label">Injected:</span>
              <div v-if="msg.isTelegram" class="msg-markdown" v-html="renderMarkdown(msg.content)"></div>
              <span v-else class="msg-text">{{ msg.content }}</span>
            </template>
            <template v-else>
              <div v-if="msg.isError" class="msg-error">{{ msg.content }}</div>
              <template v-else-if="msg.type === 'assessment'">
                <span class="msg-type-label">{{ msg.bus_id ? `Remote bus (${msg.bus_id}) assessment` : 'Assessment' }}</span>
                <div class="msg-markdown" v-html="renderMarkdown(msg.content)"></div>
              </template>
              <template v-else-if="msg.type === 'clarification'">
                <span class="msg-type-label">{{ msg.bus_id ? `Remote bus (${msg.bus_id}) clarification` : 'Clarification' }}</span>
                <div class="msg-markdown" v-html="renderMarkdown(msg.content)"></div>
              </template>
              <template v-else-if="msg.type === 'tool_running'">
                <span class="msg-type-label">Tool: {{ msg.name }}</span>
                <span class="msg-running">Running…</span>
              </template>
              <template v-else-if="msg.type === 'tool_call' && msg.accordion">
                <span class="msg-type-label">Tool: {{ msg.name }}</span>
                <div class="msg-markdown" v-html="msg.accordion"></div>
              </template>
              <template v-else-if="msg.isReport && msg.content">
                <span class="msg-type-label">Detailed report</span>
                <div class="msg-markdown" v-html="renderMarkdown(msg.content)"></div>
              </template>
              <div v-else-if="msg.content" class="msg-markdown" v-html="renderMarkdown(msg.content)"></div>
            </template>
          </div>
          <template v-if="streaming">
            <div v-for="(p, pi) in streamingParsed.parts" :key="'stream-' + pi" :class="['msg', p.role, p.type]">
              <template v-if="p.role === 'user'">
                <span v-if="p.injected" class="msg-type-label">Injected:</span>
                <div v-else-if="p.isTelegram" class="msg-markdown" v-html="renderMarkdown(p.content)"></div>
                <span v-else class="msg-text">{{ p.content }}</span>
              </template>
              <template v-else-if="p.type === 'assessment'">
                <span class="msg-type-label">{{ p.bus_id ? `Remote bus (${p.bus_id}) assessment` : 'Assessment' }}</span>
                <div class="msg-markdown" v-html="renderMarkdown(p.content)"></div>
              </template>
              <template v-else-if="p.type === 'clarification'">
                <span class="msg-type-label">{{ p.bus_id ? `Remote bus (${p.bus_id}) clarification` : 'Clarification' }}</span>
                <div class="msg-markdown" v-html="renderMarkdown(p.content)"></div>
              </template>
              <template v-else-if="p.type === 'tool_running'">
                <span class="msg-type-label">Tool: {{ p.name }}</span>
                <span class="msg-running">Running…</span>
              </template>
              <template v-else-if="p.type === 'tool_call' && p.accordion">
                <span class="msg-type-label">Tool: {{ p.name }}</span>
                <div class="msg-markdown" v-html="p.accordion"></div>
              </template>
              <div v-else-if="p.content" class="msg-markdown" v-html="renderMarkdown(p.content)"></div>
            </div>
            <div class="msg assistant">
              <div v-if="streamingParsed.tail" class="msg-markdown" v-html="renderMarkdown(streamingParsed.tail)"></div>
              <span v-else>Thinking…</span>
            </div>
          </template>
          <div ref="scrollAnchor" aria-hidden="true"></div>
        </div>
        <div class="chat-input">
          <div class="chat-input-row">
            <textarea
              v-model="inputText"
              :placeholder="sending ? 'Type to inject message…' : 'Ask the agent...'"
              rows="2"
              @keydown.enter.exact.prevent="send"
              @focus="textareaFocused = true"
              @blur="textareaFocused = false"
            />
            <button class="btn secondary" @click="stopAgent" :disabled="!sending">Stop</button>
            <button class="btn primary" @click="send" :disabled="!inputText.trim()">{{ sending ? 'Inject' : 'Send' }}</button>
          </div>
          <p class="chat-scroll-hint">Click outside the message box to stop automatic scrolling</p>
        </div>
      </section>
      <aside class="sidebar">
        <button class="btn secondary" @click="openSecretsEditor">Secrets Editor</button>
        <button class="btn secondary" @click="openConfigsEditor">Configs Editor</button>
        <button class="btn secondary" @click="openKbEditor">KB Editor</button>
        <button class="btn secondary" @click="openScheduleEditor">Schedules</button>
        <button class="btn secondary" @click="viewRecipe">View recipe</button>
        <button class="btn secondary" @click="saveRecipe">Save recipe</button>
        <button class="btn secondary" @click="loadRecipe">Load recipe</button>
        <button class="btn secondary" @click="exitChat">Exit chat</button>
      </aside>
    </main>
    <div v-if="telegramLoginStep" class="ask-user-overlay">
      <div class="ask-user-modal">
        <h3>Telegram login</h3>
        <p class="ask-user-clarification">{{ telegramLoginLabel }}</p>
        <input
          v-model="telegramLoginValue"
          :type="telegramLoginStep === 'phone' ? 'tel' : 'password'"
          :placeholder="telegramLoginPlaceholder"
          class="editor-input"
          @keydown.enter="submitTelegramLogin"
        />
        <div class="ask-user-actions">
          <button class="btn primary" @click="submitTelegramLogin">Submit</button>
        </div>
      </div>
    </div>
    <div v-if="askUserInfo" class="ask-user-overlay">
      <div class="ask-user-modal">
        <h3>Agent needs your input</h3>
        <div v-if="askUserInfo.clarification" class="ask-user-clarification msg-markdown" v-html="renderMarkdown(askUserInfo.clarification)"></div>
        <div v-if="askUserInfo.assessment" class="ask-user-assessment msg-markdown" v-html="renderMarkdown(askUserInfo.assessment)"></div>
        <p class="ask-user-countdown">Reply within {{ askUserCountdown }} seconds</p>
        <textarea v-model="askUserReply" placeholder="Type your reply..." rows="4" @keydown.enter.ctrl="submitAskUserReply" />
        <div class="ask-user-actions">
          <button class="btn primary" @click="submitAskUserReply">Send</button>
          <button class="btn secondary" @click="dismissAskUser">Cancel</button>
        </div>
      </div>
    </div>
    <div v-if="showFinalizePopup" class="ask-user-overlay"
      @click.self="dismissFinalize">
      <div class="ask-user-modal finalize-modal"
        :class="{ 'finalize-failed': finalizeInfo && !finalizeInfo.is_successful }">
        <h3>Task {{ finalizeInfo?.is_successful ? 'completed' : 'failed' }}</h3>
        <p v-if="finalizeInfo?.assessment" class="ask-user-assessment"><strong>Assessment:</strong> {{ finalizeInfo.assessment }}</p>
        <p v-if="finalizeInfo?.clarification" class="ask-user-clarification"><strong>Clarification:</strong> {{ finalizeInfo.clarification }}</p>
        <div v-if="finalizeInfo?.detailed_report" class="ask-user-clarification report-block">
          <strong>Detailed report:</strong>
          <div class="msg-markdown report-content" v-html="renderMarkdown(finalizeInfo.detailed_report)"></div>
        </div>
        <div class="ask-user-actions">
          <button class="btn primary" @click="dismissFinalize">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showSecretsEditor" class="ask-user-overlay editor-overlay" @click.self="showSecretsEditor = false">
      <div class="ask-user-modal editor-modal">
        <h3>Secrets Editor</h3>
        <p v-if="secretsError" class="editor-error">{{ secretsError }}</p>
        <div class="editor-form">
          <input v-model="secretsForm.detailed_description" type="text" placeholder="Description" class="editor-input" />
          <input v-model="secretsForm.first_factor" type="text" placeholder="First factor (e.g. user)" class="editor-input" />
          <input v-model="secretsForm.first_factor_type" type="text" placeholder="First factor type (e.g. username)" class="editor-input" />
          <input v-model="secretsForm.value" type="text" placeholder="Value (plaintext)" class="editor-input" />
          <input v-model="secretsForm.totp_secret" type="text" placeholder="TOTP seed (Base32, optional)" class="editor-input" />
          <div class="editor-form-actions">
            <button class="btn primary" @click="saveSecret">{{ secretsEditingId ? "Update" : "Add" }}</button>
            <button v-if="secretsEditingId" class="btn secondary" @click="startAddSecret">Cancel edit</button>
          </div>
        </div>
        <div class="editor-list">
          <div v-for="item in secretsItems" :key="item.id" class="editor-row">
            <div class="editor-row-fields">
              <span class="editor-row-desc">{{ item.detailed_description }}</span>
              <span class="editor-row-factor">{{ item.first_factor }}</span>
              <span class="editor-row-type">{{ item.first_factor_type }}</span>
              <span class="editor-row-value">{{ item.value }}</span>
              <span v-if="item.totp_secret" class="editor-row-badge">2FA</span>
            </div>
            <div class="editor-row-actions">
              <button class="btn secondary small" @click="startEditSecret(item)">Edit</button>
              <button class="btn secondary small" @click="deleteSecret(item.id)">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddSecret">Add new</button>
          <button class="btn secondary" @click="showSecretsEditor = false">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showConfigsEditor" class="ask-user-overlay editor-overlay" @click.self="showConfigsEditor = false">
      <div class="ask-user-modal editor-modal">
        <h3>Configs Editor</h3>
        <p v-if="configsError" class="editor-error">{{ configsError }}</p>
        <div class="editor-form">
          <input v-model="configsForm.detailed_description" type="text" placeholder="Description" class="editor-input" />
          <input v-model="configsForm.value" type="text" placeholder="Value (plaintext)" class="editor-input" />
          <div class="editor-form-actions">
            <button class="btn primary" @click="saveConfigEntry">{{ configsEditingId ? "Update" : "Add" }}</button>
            <button v-if="configsEditingId" class="btn secondary" @click="startAddConfig">Cancel edit</button>
          </div>
        </div>
        <div class="editor-list">
          <div v-for="item in configsItems" :key="item.id" class="editor-row">
            <div class="editor-row-fields">
              <span class="editor-row-desc">{{ item.detailed_description }}</span>
              <span class="editor-row-value">{{ item.value }}</span>
            </div>
            <div class="editor-row-actions">
              <button class="btn secondary small" @click="startEditConfig(item)">Edit</button>
              <button class="btn secondary small" @click="deleteConfigEntry(item.id)">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddConfig">Add new</button>
          <button class="btn secondary" @click="showConfigsEditor = false">Close</button>
        </div>
      </div>
    </div>
    <div v-if="showKbEditor" class="ask-user-overlay editor-overlay kb-editor-overlay" @click.self="showKbEditor = false">
      <div class="ask-user-modal editor-modal kb-editor-modal">
        <h3>KB Editor</h3>
        <p v-if="kbError" class="editor-error">{{ kbError }}</p>
        <div class="kb-editor-layout">
          <div class="kb-editor-list">
            <div v-for="path in kbFiles" :key="path" class="kb-editor-item"
              :class="{ selected: kbSelectedPath === path }"
              @click="selectKbFile(path)">
              {{ path }}
            </div>
          </div>
          <div class="kb-editor-form">
            <input v-model="kbFormPath" type="text" placeholder="Path (e.g. notes/doc.md)" class="editor-input" />
            <div v-if="kbEditorPreview" class="kb-editor-preview">
              <div class="msg-markdown" v-html="renderMarkdown(kbFormContent)"></div>
            </div>
            <textarea v-else v-model="kbFormContent" placeholder="Markdown content..." rows="12" class="editor-textarea"></textarea>
            <div class="editor-form-actions">
              <button class="btn primary" @click="saveKbFile" :disabled="kbSaving">
                {{ kbSaving ? "Saving…" : "Save" }}
              </button>
              <button class="btn secondary" @click="kbEditorPreview = !kbEditorPreview">
                {{ kbEditorPreview ? "Edit" : "Preview" }}
              </button>
              <button v-if="kbSelectedPath" class="btn secondary" @click="deleteKbFile" :disabled="kbSaving">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddKbFile">Add new</button>
          <button class="btn secondary" @click="showKbEditor = false">Close</button>
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
            <input v-if="scheduleSelectedId !== 'zero'" v-model="scheduleFormAt" type="datetime-local" class="editor-input" />
            <input v-model="scheduleFormTitle" type="text" placeholder="Title" class="editor-input" />
            <textarea v-model="scheduleFormInstructions" placeholder="Instructions..." rows="8" class="editor-textarea"></textarea>
            <div class="editor-form-actions">
              <button class="btn primary" @click="saveSchedule" :disabled="scheduleSaving">
                {{ scheduleSaving ? "Saving…" : (scheduleSelectedId ? "Update" : "Add") }}
              </button>
              <button v-if="scheduleSelectedId && scheduleSelectedId !== 'zero'" class="btn secondary" @click="deleteSchedule" :disabled="scheduleSaving">Delete</button>
            </div>
          </div>
        </div>
        <div class="editor-modal-actions">
          <button class="btn secondary" @click="startAddSchedule">Add new</button>
          <button class="btn secondary" @click="showScheduleEditor = false">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { marked } from "marked";

const appVersion = __APP_VERSION__;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  injected?: boolean;
  isError?: boolean;
  isReport?: boolean;
  isTelegram?: boolean;
  type?: "assessment" | "clarification" | "tool_running" | "tool_call" | "content";
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
        parts.push({ role: "assistant", type: "tool_running", name: msg.name, content: "", wait_seconds: msg.wait_seconds });
      } else if (msg.type === "tool_call" && msg.name && msg.accordion) {
        const last = parts[parts.length - 1];
        if (last?.type === "tool_running" && last.name === msg.name) parts.pop();
        parts.push({ role: "assistant", type: "tool_call", name: msg.name, accordion: msg.accordion, content: "", wait_seconds: msg.wait_seconds });
      } else if (msg.type === "send_message" && typeof msg.content === "string") {
        parts.push({ role: "assistant", content: msg.content, type: "content" });
      } else if (msg.type === "user_injected" && typeof msg.content === "string") {
        parts.push({ role: "user", content: msg.content, injected: true });
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

async function openSecretsEditor() {
  showSecretsEditor.value = true;
  secretsError.value = "";
  await refreshSecretsList();
}

async function refreshSecretsList() {
  try {
    const list = (await window.electronAPI?.secretsListFull?.()) ?? [];
    secretsItems.value = list as typeof secretsItems.value;
  } catch (err) {
    secretsItems.value = [];
    secretsError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function startAddSecret() {
  secretsEditingId.value = null;
  secretsForm.value = {
    detailed_description: "",
    first_factor: "",
    first_factor_type: "",
    value: "",
    totp_secret: "",
  };
}

function startEditSecret(entry: (typeof secretsItems.value)[0]) {
  secretsEditingId.value = entry.id;
  secretsForm.value = {
    detailed_description: entry.detailed_description,
    first_factor: entry.first_factor,
    first_factor_type: entry.first_factor_type,
    value: entry.value,
    totp_secret: entry.totp_secret ?? "",
  };
}

async function saveSecret() {
  secretsError.value = "";
  try {
    if (secretsEditingId.value) {
      await window.electronAPI?.secretsDelete?.(secretsEditingId.value);
    }
    await window.electronAPI?.secretsSet?.({
      ...secretsForm.value,
      force: false,
    });
    await refreshSecretsList();
    secretsEditingId.value = null;
    secretsForm.value = {
      detailed_description: "",
      first_factor: "",
      first_factor_type: "",
      value: "",
      totp_secret: "",
    };
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

async function deleteSecret(id: string) {
  if (!confirm("Delete this secret?")) return;
  secretsError.value = "";
  try {
    await window.electronAPI?.secretsDelete?.(id);
    await refreshSecretsList();
    if (secretsEditingId.value === id) {
      secretsEditingId.value = null;
      secretsForm.value = {
        detailed_description: "",
        first_factor: "",
        first_factor_type: "",
        value: "",
        totp_secret: "",
      };
    }
  } catch (err) {
    secretsError.value = err instanceof Error ? err.message : "Failed to delete";
  }
}

async function openConfigsEditor() {
  showConfigsEditor.value = true;
  configsError.value = "";
  await refreshConfigsList();
}

async function openKbEditor() {
  showKbEditor.value = true;
  kbError.value = "";
  await refreshKbList();
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

async function refreshKbList() {
  try {
    const list = (await window.electronAPI?.kbList?.(".", true)) ?? [];
    kbFiles.value = list.filter((p: string) => !p.endsWith("/")) as string[];
  } catch (err) {
    kbFiles.value = [];
    kbError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function selectKbFile(path: string) {
  kbSelectedPath.value = path;
  kbFormPath.value = path;
  kbError.value = "";
  window.electronAPI?.kbRead?.(path).then((c) => {
    kbFormContent.value = c;
  }).catch((err) => {
    kbError.value = err instanceof Error ? err.message : "Failed to read";
  });
}

function startAddKbFile() {
  kbSelectedPath.value = null;
  kbFormPath.value = "";
  kbFormContent.value = "";
  kbError.value = "";
}

async function saveKbFile() {
  const path = kbFormPath.value.trim();
  if (!path) {
    kbError.value = "Path is required";
    return;
  }
  if (!path.endsWith(".md") && !path.endsWith(".qmd")) {
    kbError.value = "Path must end with .md or .qmd";
    return;
  }
  kbError.value = "";
  kbSaving.value = true;
  try {
    await window.electronAPI?.kbWrite?.(path, kbFormContent.value);
    await refreshKbList();
    kbSelectedPath.value = path;
  } catch (err) {
    kbError.value = err instanceof Error ? err.message : "Failed to save";
  } finally {
    kbSaving.value = false;
  }
}

async function deleteKbFile() {
  if (!kbSelectedPath.value || !confirm(`Delete ${kbSelectedPath.value}?`)) return;
  kbError.value = "";
  kbSaving.value = true;
  try {
    await window.electronAPI?.kbDelete?.(kbSelectedPath.value);
    await refreshKbList();
    startAddKbFile();
  } catch (err) {
    kbError.value = err instanceof Error ? err.message : "Failed to delete";
  } finally {
    kbSaving.value = false;
  }
}

async function refreshConfigsList() {
  try {
    const list = (await window.electronAPI?.agentConfigList?.()) ?? [];
    configsItems.value = list as typeof configsItems.value;
  } catch (err) {
    configsItems.value = [];
    configsError.value = err instanceof Error ? err.message : "Failed to load";
  }
}

function startAddConfig() {
  configsEditingId.value = null;
  configsForm.value = { detailed_description: "", value: "" };
}

function startEditConfig(entry: (typeof configsItems.value)[0]) {
  configsEditingId.value = entry.id;
  configsForm.value = { detailed_description: entry.detailed_description, value: entry.value };
}

async function saveConfigEntry() {
  configsError.value = "";
  try {
    if (configsEditingId.value) {
      await window.electronAPI?.agentConfigDelete?.(configsEditingId.value);
    }
    await window.electronAPI?.agentConfigSet?.({
      ...configsForm.value,
      force: false,
    });
    await refreshConfigsList();
    configsEditingId.value = null;
    configsForm.value = { detailed_description: "", value: "" };
  } catch (err) {
    configsError.value = err instanceof Error ? err.message : "Failed to save";
  }
}

async function deleteConfigEntry(id: string) {
  if (!confirm("Delete this config?")) return;
  configsError.value = "";
  try {
    await window.electronAPI?.agentConfigDelete?.(id);
    await refreshConfigsList();
    if (configsEditingId.value === id) {
      configsEditingId.value = null;
      configsForm.value = { detailed_description: "", value: "" };
    }
  } catch (err) {
    configsError.value = err instanceof Error ? err.message : "Failed to delete";
  }
}

const config = ref({
  aiProvider: "claude" as "claude" | "openrouter",
  claudeApiKey: "",
  claudeModel: "claude-sonnet-4-6",
  openrouterApiKey: "",
  openrouterModel: "google/gemini-2.5-flash",
  telegramAppId: "",
  telegramApiHash: "",
  userName: "",
});

const agentReady = ref(false);
const starting = ref(false);
const startupSteps = ref<string[]>([]);
const startupMilestones = ["KB ready", "Chrome ready", "Agent ready", "Agent browser ready"];
const agentBrowserError = ref("");
const messages = ref<ChatMessage[]>([]);
const inputText = ref("");
const streaming = ref(false);
const streamBuffer = ref("");
const sending = ref(false);
const messagesRef = ref<HTMLElement | null>(null);
const scrollAnchor = ref<HTMLElement | null>(null);

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
const finalizeInfo = ref<{ assessment: string; clarification: string; is_successful: boolean; detailed_report: string } | null>(null);
const pendingReportForNextMessage = ref(false);

const taskSummary = ref("");
const taskStartTime = ref<number | null>(null);
const taskFinalized = ref(false);
const taskSuccess = ref(true);
const taskElapsedSeconds = ref(0);
let taskTimerInterval: ReturnType<typeof setInterval> | null = null;

const askUserCountdown = ref(60);

// Secrets Editor
const showSecretsEditor = ref(false);
const secretsItems = ref<
  Array<{ id: string; detailed_description: string; first_factor: string; first_factor_type: string; value: string; totp_secret?: string }>
>([]);
const secretsError = ref("");
const secretsEditingId = ref<string | null>(null);
const secretsForm = ref({
  detailed_description: "",
  first_factor: "",
  first_factor_type: "",
  value: "",
  totp_secret: "",
});

// Configs Editor
const showConfigsEditor = ref(false);
const configsItems = ref<Array<{ id: string; detailed_description: string; value: string }>>([]);
const configsError = ref("");
const configsEditingId = ref<string | null>(null);
const configsForm = ref({ detailed_description: "", value: "" });

// KB Editor
const showKbEditor = ref(false);
const kbEditorPreview = ref(false);

// Schedule Editor
const ZERO_TASK_ID = "zero";
const showScheduleEditor = ref(false);
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
const kbFiles = ref<string[]>([]);
const kbSelectedPath = ref<string | null>(null);
const kbFormPath = ref("");
const kbFormContent = ref("");
const kbError = ref("");
const kbSaving = ref(false);

let askUserCountdownTimer: ReturnType<typeof setInterval> | null = null;

let streamUnsub: (() => void) | undefined;
let askUserUnsub: (() => void) | undefined;
let askUserCloseUnsub: (() => void) | undefined;
let taskStartUnsub: (() => void) | undefined;
let finalizeUnsub: (() => void) | undefined;
let agentBrowserErrorUnsub: (() => void) | undefined;
let startupProgressUnsub: (() => void) | undefined;
let startupProgressResetUnsub: (() => void) | undefined;
let agentMessageUnsub: (() => void) | undefined;
let scheduleTriggerUnsub: (() => void) | undefined;
let telegramMessageUnsub: (() => void) | undefined;
let telegramLoginUnsub: (() => void) | undefined;

const streamingParsed = computed(() => parseStream(streamBuffer.value));

type RootHistoryMessage = { role: string; content: string; user_id?: number; user_name?: string; bus_id?: string };

function rootHistoryToMessages(hist: RootHistoryMessage[]): ChatMessage[] {
  return hist.map((m) => {
    const role = m.role as "user" | "assistant";
    const busId = m.bus_id;
    const userName = m.user_name ?? "";
    let content = m.content;
    if (role === "user" && busId) {
      content = `📱 **${busId}** (${userName}): ${content}`;
      return { role, content, type: undefined, isTelegram: true };
    }
    if (role === "assistant" && busId) {
      content = `[${busId}] ${content}`;
    }
    return { role, content, type: role === "assistant" ? "content" : undefined };
  });
}

async function refreshMessagesFromRoot(): Promise<void> {
  try {
    const rootHistory = ((await window.electronAPI?.messageBusGetHistory?.("root")) ?? []) as RootHistoryMessage[];
    messages.value = rootHistoryToMessages(rootHistory);
  } catch {
    /* ignore */
  }
}

async function startChat() {
  starting.value = true;
  try {
    const plainConfig = JSON.parse(JSON.stringify(config.value));
    const result = await window.electronAPI?.startChat?.(plainConfig);
    if (result?.ok) {
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
      agentBrowserError.value = "";
      await refreshMessagesFromRoot();
    } else {
      alert(result?.message ?? "Failed to start");
    }
  } catch (err) {
    alert(err instanceof Error ? err.message : String(err));
  } finally {
    starting.value = false;
  }
}

async function exitChat() {
  await window.electronAPI?.stopChat?.();
  agentReady.value = false;
}

function stopAgent() {
  if (sending.value) window.electronAPI?.agentAbort?.();
}

function buildHistory(msgs: ChatMessage[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  const include = (x: ChatMessage) =>
    x.role === "user" ||
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
    // Inject message into running agent (after last tool result)
    inputText.value = "";
    messages.value.push({ role: "user", content: text, injected: true });
    window.electronAPI?.agentInjectMessage?.(text, false);
    scrollToBottomAlways();
    return;
  }

  inputText.value = "";
  messages.value.push({ role: "user", content: text });
  textareaFocused.value = true;
  sending.value = true;
  streaming.value = true;
  streamBuffer.value = "";
  try {
    const history = buildHistory(messages.value.slice(0, -1));
    const reply = await window.electronAPI?.agentSendMessage?.(text, history);
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
watch(showKbEditor, (v) => {
  if (!v) kbEditorPreview.value = false;
});

onMounted(async () => {
  const cfg = await window.electronAPI?.getConfig?.();
  if (cfg) config.value = { ...config.value, ...cfg };

  streamUnsub = window.electronAPI?.onAgentStreamChunk?.((chunk) => {
    streamBuffer.value += chunk;
    scrollToBottomIfFollowing();
  });

  agentMessageUnsub = window.electronAPI?.onAgentMessage?.((content) => {
    messages.value.push({ role: "assistant", content, type: "content" });
    scrollToBottomAlways();
  });

  telegramLoginUnsub = window.electronAPI?.onTelegramLoginRequest?.((info) => {
    telegramLoginStep.value = info.step;
    telegramLoginValue.value = "";
  });

  scheduleTriggerUnsub = window.electronAPI?.onScheduleTrigger?.((msg) => {
    let displayContent = "⏰ **Scheduled task**";
    try {
      const parsed = JSON.parse(msg);
      if (typeof parsed?.content === "string" && parsed.content.trim()) {
        displayContent = `⏰ **Scheduled task**\n\n${parsed.content}`;
      }
    } catch {
      /* use default */
    }
    messages.value.push({ role: "user", content: displayContent, isTelegram: true });
    scrollToBottomAlways();
    if (sending.value) {
      window.electronAPI?.agentInjectMessage?.(msg, false);
    } else {
      sending.value = true;
      streaming.value = true;
      streamBuffer.value = "";
      window.electronAPI
        ?.agentSendMessage?.(msg, [], "root")
        ?.then(() => {})
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
        });
    }
  });

  telegramMessageUnsub = window.electronAPI?.onTelegramMessage?.((payload) => {
    const msg = JSON.stringify(payload);
    const incomingLabel = `📱 **Telegram** (${payload.user_name}): ${payload.content}`;
    messages.value.push({ role: "user", content: incomingLabel, isTelegram: true });
    scrollToBottomAlways();
    if (sending.value) {
      window.electronAPI?.agentInjectMessage?.(msg, false);
    } else {
      sending.value = true;
      streaming.value = true;
      streamBuffer.value = "";
      window.electronAPI
        ?.agentSendMessage?.(msg, [], payload.bus_id)
        ?.then(() => {})
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
        });
    }
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
    if (info.detailed_report) {
      pendingReportForNextMessage.value = true;
      const last = messages.value[messages.value.length - 1];
      if (last?.role === "assistant" && !last.isReport) last.isReport = true;
    }
  });

  agentBrowserErrorUnsub = window.electronAPI?.onAgentBrowserError?.((msg) => {
    agentBrowserError.value = msg;
  });

  startupProgressResetUnsub = window.electronAPI?.onStartupProgressReset?.(() => {
    startupSteps.value = [];
  });
  startupProgressUnsub = window.electronAPI?.onStartupProgress?.((step) => {
    const prev = startupSteps.value;
    const last = prev[prev.length - 1];
    const isQmdSubstep =
      last &&
      (last === "Connecting Knowledge Base..." || last.startsWith("Indexing") || last.includes("%") || /^\d+\/\d+/.test(last));
    const isMilestone = startupMilestones.includes(step);
    if (isQmdSubstep && !isMilestone && step !== last) {
      startupSteps.value = [...prev.slice(0, -1), step];
    } else {
      startupSteps.value = [...prev, step].slice(-15);
    }
  });
});

onUnmounted(() => {
  scrollCleanup?.();
  streamUnsub?.();
  askUserUnsub?.();
  askUserCloseUnsub?.();
  taskStartUnsub?.();
  finalizeUnsub?.();
  agentBrowserErrorUnsub?.();
  startupProgressUnsub?.();
  startupProgressResetUnsub?.();
  agentMessageUnsub?.();
  scheduleTriggerUnsub?.();
  telegramMessageUnsub?.();
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
  padding-right: 11rem; /* space for fixed sidebar */
  overflow: hidden;
}
.config {
  flex: 1;
  min-width: 0;
}
.config .field {
  margin-bottom: 1rem;
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
.msg.assistant:not(.assessment):not(.clarification):not(.tool_running):not(.tool_call):not(.report) {
  background: #1a1f26;
  border: 1px solid #252b33;
}
.msg.assistant.tool_running,
.msg.assistant.tool_call {
  background: #1e2228;
  border: 1px solid #2a3038;
}
.msg.report {
  background: #1a2a1e;
  border: 1px solid #2d4035;
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
.msg-running {
  color: #58a6ff;
}
.msg-text {
  white-space: pre-wrap;
}
.msg-error,
.msg.error .msg-text {
  color: #f85149;
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
  top: 5rem; /* below header */
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
.kb-editor-overlay .kb-editor-modal {
  width: 95vw !important;
  max-width: 95vw !important;
  height: 95vh !important;
  max-height: 95vh !important;
  display: flex;
  flex-direction: column;
}
.kb-editor-overlay .kb-editor-modal .kb-editor-layout {
  flex: 1;
  min-height: 0;
}
.kb-editor-modal {
  max-width: 800px;
}
.kb-editor-layout {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  min-height: 280px;
}
.kb-editor-list {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #0d1117;
}
.kb-editor-preview {
  flex: 1;
  min-height: 200px;
  padding: 0.75rem 1rem;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #0d1117;
  overflow-y: auto;
}
.kb-editor-preview .msg-markdown {
  font-size: 0.95rem;
  line-height: 1.6;
}
.kb-editor-item {
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
  border-bottom: 1px solid #21262d;
  word-break: break-all;
}
.kb-editor-item:hover {
  background: #21262d;
}
.kb-editor-item.selected {
  background: #1a3a5c;
  color: #58a6ff;
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

.kb-editor-form {
  flex: 1;
  min-width: 0;
  min-height: 0;
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
