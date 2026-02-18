/**
 * @file chat.js
 * @description Фронтенд-логика m006 Server-ментор — чат, SSE streaming, баланс, логирование
 * @context Загружается в index.html, управляет всей клиентской логикой
 * @dependencies marked.js, highlight.js (CDN)
 * @affects UI чата, SSE-соединения, localStorage
 */

// ============================================
// Configuration
// ============================================
const MODULE_ID = 'm006';
const API_BASE = '';  // Same origin
const LOG_ENDPOINT = '/api/log';
const HEARTBEAT_INTERVAL = 30000;
const LOG_FLUSH_INTERVAL = 5000;
const MAX_LOG_BATCH = 50;

// ============================================
// State
// ============================================
let currentUserId = null;
let currentSessionId = null;
let isStreaming = false;
let sidebarCollapsed = false;

// URL parameters
const urlParams = new URLSearchParams(window.location.search);
const paramUserId = urlParams.get('user_id');
const paramShellId = urlParams.get('shell');
const paramExternalUserId = urlParams.get('external_user_id') || urlParams.get('studentId');
const paramProvider = urlParams.get('provider') || (urlParams.get('studentId') ? 'prodamus_xl' : null);
const paramTenant = urlParams.get('tenant') || (urlParams.get('schoolNumber') ? `xl:${urlParams.get('schoolNumber')}` : null);

/**
 * Определить origin_url для оболочки (Prodamus.XL fallback)
 */
function getShellOriginUrl() {
  const referrer = document.referrer;
  if (referrer) {
    try {
      const referrerUrl = new URL(referrer);
      if (referrerUrl.hostname.endsWith('.xl.ru') || referrerUrl.hostname === 'xl.ru') {
        return referrer;
      }
    } catch (e) { /* ignore */ }
  }
  return window.location.href;
}

// ============================================
// Frontend Logger
// ============================================
const FrontendLogger = (() => {
  let buffer = [];
  let interactionCount = 0;
  let errorCount = 0;
  let fetchCount = 0;
  const startTime = Date.now();

  function log(level, event, data = {}) {
    buffer.push({
      level,
      event,
      message: data.message || event,
      timestamp: new Date().toISOString(),
      sessionId: currentSessionId,
      userId: currentUserId,
      url: window.location.href,
      userAgent: navigator.userAgent,
      data,
    });

    if (buffer.length >= MAX_LOG_BATCH) {
      flush();
    }
  }

  function flush() {
    if (buffer.length === 0) return;
    const entries = buffer.splice(0, MAX_LOG_BATCH);

    try {
      const blob = new Blob([JSON.stringify({ entries })], { type: 'application/json' });
      navigator.sendBeacon(LOG_ENDPOINT, blob);
    } catch (_e) {
      // Fallback: fetch
      fetch(LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      }).catch(() => {});
    }
  }

  // Heartbeat
  function sendHeartbeat() {
    log('info', 'heartbeat', {
      uptime_ms: Date.now() - startTime,
      interactions: interactionCount,
      errors: errorCount,
      fetches: fetchCount,
      online: navigator.onLine,
      focused: document.hasFocus(),
      memory: performance.memory
        ? {
            used: performance.memory.usedJSHeapSize,
            total: performance.memory.totalJSHeapSize,
          }
        : null,
    });
  }

  // Fetch interceptor
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    if (url.includes('/api/log')) return originalFetch.apply(this, args);

    fetchCount++;
    const start = Date.now();
    try {
      const response = await originalFetch.apply(this, args);
      log('debug', 'fetch_complete', {
        url,
        method: args[1]?.method || 'GET',
        status: response.status,
        duration_ms: Date.now() - start,
      });
      return response;
    } catch (err) {
      log('error', 'fetch_error', {
        url,
        method: args[1]?.method || 'GET',
        error: err.message,
        duration_ms: Date.now() - start,
      });
      throw err;
    }
  };

  // Click tracker
  document.addEventListener(
    'click',
    (e) => {
      interactionCount++;
      const el = e.target;
      log('debug', 'click', {
        tag: el.tagName,
        id: el.id || undefined,
        className: (el.className || '').toString().substring(0, 80),
        text: (el.textContent || '').substring(0, 50),
      });
    },
    true
  );

  // Keyboard tracker (значимые клавиши)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape' || e.ctrlKey || e.altKey || e.metaKey) {
      interactionCount++;
      log('debug', 'keydown', {
        key: e.key,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      });
    }
  });

  // Console capture
  const origError = console.error;
  const origWarn = console.warn;
  console.error = function (...args) {
    errorCount++;
    log('error', 'console_error', { args: args.map(String).join(' ') });
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    log('warn', 'console_warn', { args: args.map(String).join(' ') });
    origWarn.apply(console, args);
  };

  // Focus/blur
  window.addEventListener('focus', () => log('info', 'window_focus'));
  window.addEventListener('blur', () => log('info', 'window_blur'));

  // Global error handlers
  window.addEventListener('error', (e) => {
    errorCount++;
    log('error', 'global_error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    errorCount++;
    log('error', 'unhandled_rejection', { reason: String(e.reason) });
  });

  // Long task detection
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 100) {
            log('warn', 'long_task', { duration_ms: entry.duration });
          }
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch (_e) {}
  }

  // Connection info
  log('info', 'init', {
    screen: `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    cores: navigator.hardwareConcurrency,
    connection: navigator.connection
      ? {
          type: navigator.connection.effectiveType,
          downlink: navigator.connection.downlink,
        }
      : null,
    language: navigator.language,
  });

  // Auto-flush
  setInterval(flush, LOG_FLUSH_INTERVAL);
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  window.addEventListener('beforeunload', flush);

  return { log, flush };
})();

// ============================================
// DOM Elements
// ============================================
const $sidebar = document.getElementById('sidebar');
const $conversationsList = document.getElementById('conversations-list');
const $searchConversations = document.getElementById('search-conversations');
const $chatMessages = document.getElementById('chat-messages');
const $welcomeScreen = document.getElementById('welcome-screen');
const $messageInput = document.getElementById('message-input');
const $btnSend = document.getElementById('btn-send');
const $btnNewChat = document.getElementById('btn-new-chat');
const $btnDownload = document.getElementById('btn-download');
const $btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
const $btnOpenSidebar = document.getElementById('btn-open-sidebar');
const $statusBar = document.getElementById('status-bar');
const $statusText = document.getElementById('status-text');
const $toastContainer = document.getElementById('toast-container');

// Balance elements
const $btnBalance = document.getElementById('btn-balance');
const $balancePopover = document.getElementById('balance-popover');
const $btnCloseBalance = document.getElementById('btn-close-balance');
const $balanceLoading = document.getElementById('balance-loading');
const $balanceContent = document.getElementById('balance-content');
const $balanceError = document.getElementById('balance-error');
const $balanceValue = document.getElementById('balance-value');
const $balanceCurrency = document.getElementById('balance-currency');
const $balanceBadge = document.getElementById('balance-badge');
const $btnRefreshBalance = document.getElementById('btn-refresh-balance');
const $btnRetryBalance = document.getElementById('btn-retry-balance');
const $btnTopup = document.getElementById('btn-topup');

// ============================================
// Marked.js Configuration
// ============================================
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (_e) {}
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true,
});

// Custom renderer for code blocks with copy button
const renderer = new marked.Renderer();
renderer.code = function (code, language) {
  const codeText = typeof code === 'object' ? code.text : code;
  const codeLang = typeof code === 'object' ? code.lang : language;
  const langLabel = codeLang || 'text';
  const highlighted = codeLang && hljs.getLanguage(codeLang)
    ? hljs.highlight(codeText, { language: codeLang }).value
    : hljs.highlightAuto(codeText).value;

  return `<pre><div class="code-block-header"><span>${langLabel}</span><button class="btn-copy-code" onclick="copyCode(this)">Копировать</button></div><code class="hljs language-${langLabel}">${highlighted}</code></pre>`;
};

marked.use({ renderer });

// ============================================
// Utility Functions
// ============================================
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  $toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
  FrontendLogger.log(type === 'error' ? 'error' : 'info', 'toast_shown', { message, type });
}

function showStatus(text) {
  $statusText.textContent = text;
  $statusBar.classList.remove('hidden');
}

function hideStatus() {
  $statusBar.classList.add('hidden');
}

function setLoading(loading) {
  $btnSend.disabled = loading || !$messageInput.value.trim();
  if (loading) {
    $messageInput.disabled = true;
  } else {
    $messageInput.disabled = false;
    $messageInput.focus();
  }
}

// Copy code block
window.copyCode = function (btn) {
  const codeEl = btn.closest('pre').querySelector('code');
  const text = codeEl.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ Скопировано';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Копировать';
      btn.classList.remove('copied');
    }, 2000);
  });
  FrontendLogger.log('info', 'code_copied', { length: text.length });
};

function renderMarkdown(text) {
  return marked.parse(text);
}

function autoResizeInput() {
  $messageInput.style.height = 'auto';
  $messageInput.style.height = Math.min($messageInput.scrollHeight, 180) + 'px';
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $chatMessages.scrollTop = $chatMessages.scrollHeight;
  });
}

// ============================================
// Initialization
// ============================================
async function init() {
  FrontendLogger.log('info', 'app_init_start');

  // Determine user_id
  if (paramUserId) {
    currentUserId = paramUserId;
    FrontendLogger.log('info', 'user_from_param', { userId: currentUserId });
  } else if (paramExternalUserId && paramProvider && paramTenant) {
    try {
      const resp = await fetch('/api/chat/identity/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: paramProvider,
          tenant: paramTenant,
          external_user_id: paramExternalUserId,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        currentUserId = data.user_id;
        FrontendLogger.log('info', 'identity_resolved', { userId: currentUserId, isNew: data.is_new });
      } else {
        throw new Error(data.error?.message || 'Identity resolution failed');
      }
    } catch (err) {
      FrontendLogger.log('error', 'identity_init_failed', { error: err.message });
      showToast('Ошибка идентификации. Попробуйте обновить страницу.', 'error');
      return;
    }
  } else {
    // Fallback: localStorage
    currentUserId = localStorage.getItem(`${MODULE_ID}_user_id`);
    if (!currentUserId) {
      currentUserId = 'local_' + crypto.randomUUID();
      localStorage.setItem(`${MODULE_ID}_user_id`, currentUserId);
    }
    FrontendLogger.log('info', 'user_local', { userId: currentUserId });
  }

  // Load conversations
  await loadConversations();

  // Restore last session
  const lastSession = localStorage.getItem(`${MODULE_ID}_last_session`);
  if (lastSession) {
    await loadConversation(lastSession);
  }

  FrontendLogger.log('info', 'app_init_complete');
}

// ============================================
// Conversations
// ============================================
async function loadConversations() {
  FrontendLogger.log('info', 'load_conversations_start');

  try {
    const resp = await fetch(`/api/conversations?user_id=${encodeURIComponent(currentUserId)}`);
    const data = await resp.json();

    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to load conversations');
    }

    renderConversationsList(data.conversations || []);
    FrontendLogger.log('info', 'load_conversations_done', { count: (data.conversations || []).length });
  } catch (err) {
    FrontendLogger.log('error', 'load_conversations_error', { error: err.message });
    $conversationsList.innerHTML = '<div class="conversations-empty">Ошибка загрузки бесед</div>';
  }
}

function renderConversationsList(conversations) {
  if (conversations.length === 0) {
    $conversationsList.innerHTML = '<div class="conversations-empty">Нет бесед. Начните новую!</div>';
    return;
  }

  $conversationsList.innerHTML = conversations
    .map(
      (conv) => `
    <div class="conversation-item ${conv.session_id === currentSessionId ? 'active' : ''}"
         data-session-id="${conv.session_id}"
         onclick="loadConversation('${conv.session_id}')">
      <span class="conv-icon">💻</span>
      <div class="conv-info">
        <div class="conv-title">${escapeHtml(conv.title || 'Новая беседа')}</div>
        <div class="conv-meta">${formatDate(conv.updated_at)} · ${conv.message_count || 0} сообщ.</div>
      </div>
    </div>
  `
    )
    .join('');
}

window.loadConversation = async function (sessionId) {
  FrontendLogger.log('info', 'load_conversation', { sessionId });

  try {
    const resp = await fetch(`/api/conversations/${sessionId}?user_id=${encodeURIComponent(currentUserId)}`);
    const data = await resp.json();

    if (!data.success) {
      throw new Error(data.error?.message || 'Failed to load conversation');
    }

    currentSessionId = sessionId;
    localStorage.setItem(`${MODULE_ID}_last_session`, sessionId);

    // Render messages
    $welcomeScreen.classList.add('hidden');
    renderMessages(data.conversation.messages || []);
    scrollToBottom();

    // Highlight active conversation
    document.querySelectorAll('.conversation-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.sessionId === sessionId);
    });

    FrontendLogger.log('info', 'load_conversation_done', {
      sessionId,
      messageCount: (data.conversation.messages || []).length,
    });
  } catch (err) {
    FrontendLogger.log('error', 'load_conversation_error', { sessionId, error: err.message });
    showToast('Ошибка загрузки беседы', 'error');
  }
};

function renderMessages(messages) {
  const html = messages
    .filter((m) => m.role !== 'system')
    .map(
      (m) => `
    <div class="message ${m.role}">
      <div class="message-avatar">${m.role === 'user' ? '👤' : '⌘'}</div>
      <div class="message-content">
        <div class="message-role">${m.role === 'user' ? 'Вы' : 'Server-ментор'}</div>
        <div class="message-text">${m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content)}</div>
      </div>
    </div>
  `
    )
    .join('');

  $chatMessages.innerHTML = html;
}

// ============================================
// Send Message (Streaming)
// ============================================
async function sendMessage() {
  const message = $messageInput.value.trim();
  if (!message || isStreaming) return;

  FrontendLogger.log('info', 'send_message_start', { messageLength: message.length });

  // Create session if needed
  if (!currentSessionId) {
    try {
      const resp = await fetch('/api/chat/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: currentUserId }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error?.message || 'Failed to create session');

      currentSessionId = data.session_id;
      localStorage.setItem(`${MODULE_ID}_last_session`, currentSessionId);
      FrontendLogger.log('info', 'session_created', { sessionId: currentSessionId });
    } catch (err) {
      FrontendLogger.log('error', 'session_create_failed', { error: err.message });
      showToast('Ошибка создания беседы', 'error');
      return;
    }
  }

  // Hide welcome screen
  $welcomeScreen.classList.add('hidden');

  // Add user message to UI
  appendMessage('user', message);

  // Clear input
  $messageInput.value = '';
  autoResizeInput();
  isStreaming = true;
  setLoading(true);

  // Prepare assistant message container
  const assistantDiv = appendMessage('assistant', '', true);
  const textEl = assistantDiv.querySelector('.message-text');

  // Start streaming
  try {
    const body = {
      session_id: currentSessionId,
      user_id: currentUserId,
      message,
    };
    if (paramShellId) body.shell_id = paramShellId;
    if (!paramShellId) body.origin_url = getShellOriginUrl();

    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      throw new Error(errData.error?.message || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let sseBuffer = '';
    let firstDeltaReceived = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.substring(7).trim();
        } else if (line.startsWith('data: ')) {
          const jsonStr = line.substring(6);
          try {
            const data = JSON.parse(jsonStr);
            handleSSEEvent(eventType, data, textEl, (delta) => {
              if (!firstDeltaReceived) {
                firstDeltaReceived = true;
                hideStatus();
                FrontendLogger.log('info', 'first_delta_received');
              }
              fullText += delta;
              textEl.classList.add('streaming-cursor');
              textEl.innerHTML = renderMarkdown(fullText);
              scrollToBottom();
            });
          } catch (_e) {}
        }
      }
    }

    // Finalize
    textEl.classList.remove('streaming-cursor');
    textEl.innerHTML = renderMarkdown(fullText);
    scrollToBottom();

    FrontendLogger.log('info', 'send_message_done', { responseLength: fullText.length });

    // Reload conversations list
    await loadConversations();
  } catch (err) {
    FrontendLogger.log('error', 'send_message_error', { error: err.message });
    textEl.classList.remove('streaming-cursor');
    textEl.innerHTML = `<div style="color:var(--color-error)">Ошибка: ${escapeHtml(err.message)}</div>`;
    showToast('Ошибка отправки сообщения', 'error');
  } finally {
    isStreaming = false;
    setLoading(false);
    hideStatus();
  }
}

function handleSSEEvent(eventType, data, textEl, onDelta) {
  if (eventType === 'status') {
    showStatus(data.status || 'Обработка...');
  } else if (eventType === 'text_delta') {
    onDelta(data.delta || '');
  } else if (eventType === 'done') {
    hideStatus();
    FrontendLogger.log('info', 'stream_done', { usage: data.usage });
  } else if (eventType === 'error') {
    hideStatus();
    FrontendLogger.log('error', 'stream_error', { errorCode: data.errorCode, errorMessage: data.errorMessage });
    showToast(data.errorMessage || 'Ошибка', 'error');
  }
}

function appendMessage(role, content, isStreaming = false) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = `
    <div class="message-avatar">${role === 'user' ? '👤' : '⌘'}</div>
    <div class="message-content">
      <div class="message-role">${role === 'user' ? 'Вы' : 'Server-ментор'}</div>
      <div class="message-text ${isStreaming ? 'streaming-cursor' : ''}">
        ${role === 'assistant' ? (content ? renderMarkdown(content) : '<div class="typing-indicator"><span></span><span></span><span></span></div>') : escapeHtml(content)}
      </div>
    </div>
  `;
  $chatMessages.appendChild(div);
  scrollToBottom();
  return div;
}

// ============================================
// Balance
// ============================================
async function fetchBalance() {
  FrontendLogger.log('info', 'fetch_balance_start');

  $balanceLoading.classList.remove('hidden');
  $balanceContent.classList.add('hidden');
  $balanceError.classList.add('hidden');

  try {
    let url = `/api/balance?user_id=${encodeURIComponent(currentUserId)}`;
    if (paramShellId) url += `&shell_id=${encodeURIComponent(paramShellId)}`;
    else url += `&origin_url=${encodeURIComponent(getShellOriginUrl())}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.success) throw new Error(data.error?.message || 'Balance fetch failed');

    $balanceValue.textContent = parseFloat(data.balance).toFixed(2);
    $balanceCurrency.textContent = data.currency_name || '';
    $balanceBadge.classList.remove('hidden');

    if (data.topup_url) {
      $btnTopup.href = data.topup_url;
      $btnTopup.classList.remove('hidden');
    } else {
      $btnTopup.classList.add('hidden');
    }

    $balanceLoading.classList.add('hidden');
    $balanceContent.classList.remove('hidden');

    FrontendLogger.log('info', 'fetch_balance_done', { balance: data.balance });
  } catch (err) {
    FrontendLogger.log('error', 'fetch_balance_error', { error: err.message });
    $balanceLoading.classList.add('hidden');
    $balanceError.classList.remove('hidden');
  }
}

function toggleBalancePopover() {
  const isHidden = $balancePopover.classList.contains('hidden');
  $balancePopover.classList.toggle('hidden');
  if (isHidden) {
    fetchBalance();
  }
  FrontendLogger.log('info', 'balance_popover_toggle', { opened: isHidden });
}

// ============================================
// Download Conversation
// ============================================
async function downloadConversation() {
  if (!currentSessionId) {
    showToast('Нет активной беседы для скачивания', 'warning');
    return;
  }

  FrontendLogger.log('info', 'download_start', { sessionId: currentSessionId });

  try {
    const url = `/api/conversations/${currentSessionId}/download?user_id=${encodeURIComponent(currentUserId)}`;
    const resp = await fetch(url);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `server-mentor_${currentSessionId}.md`;
    a.click();
    URL.revokeObjectURL(a.href);

    FrontendLogger.log('info', 'download_done');
  } catch (err) {
    FrontendLogger.log('error', 'download_error', { error: err.message });
    showToast('Ошибка скачивания', 'error');
  }
}

// ============================================
// New Chat
// ============================================
async function createNewChat() {
  FrontendLogger.log('info', 'create_new_chat');

  currentSessionId = null;
  localStorage.removeItem(`${MODULE_ID}_last_session`);

  // Reset UI
  $chatMessages.innerHTML = '';
  $chatMessages.appendChild($welcomeScreen);
  $welcomeScreen.classList.remove('hidden');

  // Deselect all conversations
  document.querySelectorAll('.conversation-item').forEach((el) => el.classList.remove('active'));

  $messageInput.value = '';
  $messageInput.focus();
}

// ============================================
// Sidebar Toggle
// ============================================
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  $sidebar.classList.toggle('collapsed', sidebarCollapsed);
  $btnOpenSidebar.classList.toggle('hidden', !sidebarCollapsed);
  FrontendLogger.log('info', 'sidebar_toggle', { collapsed: sidebarCollapsed });
}

// ============================================
// Search Conversations
// ============================================
function filterConversations(query) {
  const items = $conversationsList.querySelectorAll('.conversation-item');
  const q = query.toLowerCase();
  items.forEach((item) => {
    const title = item.querySelector('.conv-title')?.textContent?.toLowerCase() || '';
    item.style.display = title.includes(q) ? '' : 'none';
  });
}

// ============================================
// Helper Functions
// ============================================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'только что';
  if (diffMins < 60) return `${diffMins} мин. назад`;
  if (diffHours < 24) return `${diffHours} ч. назад`;
  if (diffDays < 7) return `${diffDays} дн. назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// ============================================
// Event Listeners
// ============================================
$btnSend.addEventListener('click', sendMessage);
$btnNewChat.addEventListener('click', createNewChat);
$btnDownload.addEventListener('click', downloadConversation);
$btnToggleSidebar.addEventListener('click', toggleSidebar);
$btnOpenSidebar.addEventListener('click', toggleSidebar);

$messageInput.addEventListener('input', () => {
  autoResizeInput();
  $btnSend.disabled = !$messageInput.value.trim() || isStreaming;
});

$messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming && $messageInput.value.trim()) {
      sendMessage();
    }
  }
});

// Balance events
$btnBalance.addEventListener('click', toggleBalancePopover);
$btnCloseBalance.addEventListener('click', () => $balancePopover.classList.add('hidden'));
$btnRefreshBalance.addEventListener('click', fetchBalance);
$btnRetryBalance.addEventListener('click', fetchBalance);

// Close balance popover on outside click
document.addEventListener('click', (e) => {
  if (!$balancePopover.classList.contains('hidden') && !e.target.closest('.balance-widget')) {
    $balancePopover.classList.add('hidden');
  }
});

// Example buttons
document.querySelectorAll('.example-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const prompt = btn.dataset.prompt;
    if (prompt) {
      $messageInput.value = prompt;
      autoResizeInput();
      $btnSend.disabled = false;
      sendMessage();
    }
  });
});

// Search
$searchConversations.addEventListener('input', (e) => {
  filterConversations(e.target.value);
});

// Scroll tracking (debounced)
let scrollTimer = null;
$chatMessages.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    FrontendLogger.log('debug', 'scroll', {
      scrollTop: $chatMessages.scrollTop,
      scrollHeight: $chatMessages.scrollHeight,
      clientHeight: $chatMessages.clientHeight,
    });
  }, 2000);
});

// ============================================
// Start
// ============================================
init();
