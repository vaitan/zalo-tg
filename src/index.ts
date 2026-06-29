import { getZaloApi, resetZaloApi } from './zalo/client.js';
import { CloseReason, ThreadType } from 'zca-js';
import { setupZaloHandler } from './zalo/handler.js';
import { tgBot, syncTelegramCommands } from './telegram/bot.js';
import { setupTelegramHandler } from './telegram/handler.js';
import { config } from './config.js';
import { startUpdateChecker } from './updater.js';
import { store } from './store.js';

// ── Global safety net — prevent unhandled rejections from crashing ────────────
process.on('unhandledRejection', (reason) => {
  const err = reason as any;

  if (err?.code === 'EAI_AGAIN') {
    console.warn('[Boot] Không thể kết nối mạng (EAI_AGAIN). Đang chờ mạng ổn định...');
    return;
  }

  console.error('[Boot] Unhandled rejection (ignored):', reason);
});

process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EAI_AGAIN') {
    console.warn('[Boot] Uncaught exception due to network issue (EAI_AGAIN). Đang chờ mạng ổn định...');
    return;
  }

  console.error('[Boot] Uncaught exception (ignored):', err);

  _reconnectInProgress = false;
});

// ── Module-level ref to Telegram handler's API setter (used by reconnect) ──────
let _setZaloApi: ((api: Awaited<ReturnType<typeof getZaloApi>>) => void) | null = null;
let _reconnectInProgress = false;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _initialLoginAttempted = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const APP_RESTART_EXIT_CODE = 43;

function restartApp(reason: string): void {
  console.warn(`[Boot] Restarting app: ${reason}`);
  setTimeout(() => process.exit(APP_RESTART_EXIT_CODE), 500);
}

// ── Boot Zalo (also used when /login swaps in a fresh API) ───────────────────

async function pruneLeftGroupTopics(api: Awaited<ReturnType<typeof getZaloApi>>): Promise<void> {
  try {
    const groups = await api.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
    const activeGroupIds = new Set(Object.keys(groups?.gridVerMap ?? {}));
    const removed: string[] = [];
    for (const entry of store.all()) {
      if (entry.type === 1 && !activeGroupIds.has(entry.zaloId)) {
        store.remove(entry.topicId);
        removed.push(`${entry.name} (${entry.zaloId})`);
      }
    }
    if (removed.length > 0) {
      console.log(`[Boot] Pruned ${removed.length} stale group topic(s): ${removed.join(', ')}`);
    }
  } catch (err) {
    console.warn('[Boot] Could not prune stale group topics:', err);
  }
}

async function reconnectOnce(
  api: Awaited<ReturnType<typeof getZaloApi>>
): Promise<boolean> {

  return new Promise((resolve) => {

    let finished = false;

    const done = (ok: boolean) => {
      if (finished) return;
      finished = true;
      resolve(ok);
    };

    try {

      try {
        api.listener.stop();
      } catch { }

      // KHÔNG removeAllListeners()

      const timeout = setTimeout(() => {
        console.warn('[Boot] Reconnect timeout');
        done(false);
      }, 10000);

      api.listener.once('connected', () => {

        clearTimeout(timeout);

        try {
          api.listener.requestOldMessages(ThreadType.User);
          api.listener.requestOldMessages(ThreadType.Group);

          api.listener.requestOldReactions(ThreadType.User);
          api.listener.requestOldReactions(ThreadType.Group);
        } catch { }

        console.log('[Boot] Zalo connected ✓');

        done(true);
      });

      api.listener.once('disconnected', () => {
        clearTimeout(timeout);
        done(false);
      });

      api.listener.once('error', (err: any) => {
        if (err?.code === 'EAI_AGAIN' || err?.message?.includes?.('EAI_AGAIN') || err?.message?.includes?.('getaddrinfo') || err?.cause?.code === 'EAI_AGAIN') {
          return;
        }
        console.warn('[Boot] reconnect error:', err);
      });

      try {
        api.listener.start();
      } catch (err) {
        clearTimeout(timeout);
        console.warn('[Boot] listener.start() failed:', err);
        done(false);
      }

    } catch (err) {
      console.warn('[Boot] reconnectOnce failed:', err);
      done(false);
    }
  });
}

async function infiniteReconnectLoop(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  initialDelay = 5000
): Promise<void> {
  if (_reconnectInProgress) return;

  _reconnectInProgress = true;

  try {
    await sleep(initialDelay);

    let attempt = 1;

    while (true) {
      try {
        if (attempt === 1) {
          console.log(
            `[Boot] Đang thử kết nối lại Zalo...`
          );
        }

        const ok = await reconnectOnce(api);

        if (ok) {
          console.log('[Boot] Zalo softly reconnected ✓');

          //clear logged messages
          console.clear();                    // thử trước
          process.stdout.write('\x1Bc');      // Reset terminal hoàn toàn

          tgBot.telegram
            .sendMessage(
              config.telegram.groupId,
              '✅ Đã có mạng. Zalo kết nối lại thành công.'
            )
            .catch(() => undefined);

          break;
        }
      } catch (err) {
        console.warn(
          '[Boot] reconnect loop error (ignored):',
          err
        );
      }

      attempt++;

      // console.log('[Boot] Retry sau 10 giây...');
      await sleep(10000);
    }
  } finally {
    _reconnectInProgress = false;
  }
}

/**
 * Retry Zalo login with exponential backoff.
 * Never stops - will keep retrying forever until successful.
 */
async function infiniteInitialLoginLoop(): Promise<void> {
  let attempt = 1;
  let backoffMs = 5000; // Bắt đầu từ 5 giây
  const maxBackoffMs = 300000; // Tối đa 5 phút giữa các lần thử

  while (true) {
    try {
      console.log(`[Boot] Đang thử đăng nhập Zalo lần thứ ${attempt}...`);
      const api = await getZaloApi();
      _setZaloApi?.(api);
      await startZalo(api);
      console.log('[Boot] Zalo auto-login thành công ✓');
      break;
    } catch (err) {
      console.warn(`[Boot] Zalo auto-login thất bại (Lần ${attempt}):`, err);
      attempt += 1;

      // Chờ với exponential backoff
      console.log(`[Boot] Chờ ${Math.round(backoffMs / 1000)}s trước khi thử lại đăng nhập...`);
      await sleep(backoffMs);

      // Tăng backoff cho lần thử tiếp theo
      backoffMs = Math.min(backoffMs * 1.5, maxBackoffMs);
    }
  }
}

/**
 * Setup disconnection handler for a listener.
 * Call this BEFORE listener.start() to catch all disconnect events.
 */
function setupDisconnectionHandler(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  isReconnect: boolean
): void {

  // tránh attach nhiều lần
  // @ts-ignore
  if (api.__disconnectHandlerAttached) {
    return;
  }

  // @ts-ignore
  api.__disconnectHandlerAttached = true;

  api.listener.on(
    'disconnected',
    (code: CloseReason, reason: string) => {

      if (_reconnectInProgress) {
        return;
      }

      if (code === CloseReason.ManualClosure) {
        return;
      }

      if (code === CloseReason.DuplicateConnection) {
        console.warn('[Boot] Zalo bị ngắt do duplicate connection.');

        void tgBot.telegram.sendMessage(
          config.telegram.groupId,
          '⚠️ Zalo bị ngắt do đăng nhập trùng phiên. Dùng <b>/login</b> để vào lại.',
          { parse_mode: 'HTML' }
        ).catch(() => undefined)
          .finally(() => restartApp('duplicate connection'));

        return;
      }

      if (code === CloseReason.KickConnection) {
        console.warn('[Boot] Zalo bị kick connection.');

        tgBot.telegram.sendMessage(
          config.telegram.groupId,
          '⚠️ Zalo đã ngắt phiên bridge. Vui lòng đăng nhập lại bằng <b>/login</b>.',
          { parse_mode: 'HTML' }
        ).catch(() => undefined);

        return;
      }

      console.warn(
        `[Boot] Zalo mất mạng (code=${code}, reason=${reason})`
      );

      tgBot.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Mất kết nối mạng. Bot đang tự động khôi phục...'
      ).catch(() => undefined);

      void infiniteReconnectLoop(api, 5000);
    }
  );
}

async function startZalo(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  isReconnect = false,
): Promise<void> {
  // 1. Chỉ dọn dẹp và gắn Handler 1 lần duy nhất ở lần chạy đầu tiên.
  // Khôi phục mềm (Soft Reconnect) sẽ bỏ qua bước này để tránh bị lặp sự kiện.
  if (!isReconnect) {
    void pruneLeftGroupTopics(api);
    await setupZaloHandler(api);
  }

  // 2. Kích hoạt lệnh kéo tin nhắn lỡ ngay khi kết nối WebSocket thành công
  if (isReconnect) {
    // Attach connected handler BEFORE starting the listener to avoid missing it
    try {
      api.listener.once('connected', () => {
        try {
          api.listener.requestOldMessages(ThreadType.User);
          api.listener.requestOldMessages(ThreadType.Group);
          api.listener.requestOldReactions(ThreadType.User);
          api.listener.requestOldReactions(ThreadType.Group);
          console.log('[Boot] Đã gửi yêu cầu đồng bộ (Catch-up sync) ngay khi có mạng');
        } catch (err) {
          console.warn('[Boot] Lỗi khi yêu cầu đồng bộ:', err);
        }
      });
    } catch (err) {
      console.warn('[Boot] Could not attach connected handler (ignored):', err);
    }
  }

  // Attach disconnection handler BEFORE starting the listener
  // This ensures we catch all disconnect events, including the first one
  try {
    setupDisconnectionHandler(api, isReconnect);
  } catch (err) {
    console.warn('[Boot] Could not attach disconnection handler (ignored):', err);
  }

  // Start listener with protection and attach low-level error handlers if possible
  try {
    // Best-effort: attach handlers before start to avoid unhandled errors
    try {
      if (typeof api.listener.on === 'function') {
        api.listener.on('error', (err: any) => {
          if (err?.code === 'EAI_AGAIN' || err?.message?.includes?.('EAI_AGAIN') || err?.message?.includes?.('getaddrinfo') || err?.cause?.code === 'EAI_AGAIN') {
            return;
          }
          console.warn('[Boot] Listener error (ignored):', err);
        });
      }
      // @ts-ignore
      if (api.listener?.ws && typeof api.listener.ws.on === 'function') {
        // @ts-ignore
        api.listener.ws.on('error', (err: unknown) => {
          console.warn('[Boot] Underlying WS error (ignored):', err);
        });
      }
    } catch (err) {
      console.warn('[Boot] Could not attach listener error handlers (ignored):', err);
    }

    try {
      api.listener.start();
    } catch (err) {
      console.warn('[Boot] Lỗi khi khởi động listener (ignored):', err);
    }
  } catch (err) {
    console.warn('[Boot] startZalo: unexpected error while starting listener (ignored):', err);
  }

  console.log(`[Boot] Zalo listener ${isReconnect ? 're' : ''}started ✓`);
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Zalo ↔ Telegram Bridge  v1.0.0    ║');
  console.log('╚══════════════════════════════════════╝');

  // ── Auto update checker — must register BEFORE setupTelegramHandler ─────────
  startUpdateChecker(tgBot);

  // ── Wire up Telegram handler BEFORE launching the bot ─────────────────────
  const setZaloApi = setupTelegramHandler(null, async (newApi) => {
    await startZalo(newApi, true);
  });
  _setZaloApi = setZaloApi;

  // ── Register bot commands for Telegram menu ───────────────────────────────
  tgBot.telegram.setMyCommands([
    { command: 'login', description: 'Đăng nhập Zalo qua QR code' },
    { command: 'loginweb', description: 'Đăng nhập Zalo QR (giống /login)' },
    { command: 'loginapp', description: 'Đăng nhập Zalo qua PC App API' },
    { command: 'search', description: 'Tìm bạn bè / nhóm Zalo để tạo topic' },
    { command: 'group_info', description: 'Xem thông tin & thành viên nhóm Zalo hiện tại' },
    { command: 'group_infoall', description: 'Xem toàn bộ thành viên nhóm Zalo hiện tại' },
    { command: 'addfriend', description: 'Tìm & kết bạn Zalo theo số điện thoại' },
    { command: 'addgroup', description: 'Tạo topic cho nhóm Zalo chưa có topic' },
    { command: 'joingroup', description: 'Tham gia nhóm Zalo qua link' },
    { command: 'leavegroup', description: 'Rời nhóm Zalo & đóng topic (dùng trong topic nhóm)' },
    { command: 'friendrequests', description: 'Xem lời mời kết bạn & lời mời nhóm' },
    { command: 'topic', description: 'Quản lý topic: list / info / delete' },
    { command: 'history', description: 'Nạp lịch sử chat nhóm vào topic (dùng trong topic nhóm)' },
    { command: 'autoreply', description: 'Tự trả lời DM khi offline: on / off / status' },
    { command: 'recall', description: 'Thu hồi tin nhắn (reply vào tin đã gửi)' },
    { command: 'admin', description: 'Admin panel: trạng thái, cache, tra mapping' },
    { command: 'status', description: 'Xem trạng thái bridge: uptime, số topic, Zalo' },
    { command: 'update', description: 'Kiểm tra bản cập nhật mới' },
  ]).catch(() => undefined);

  // ── Lệnh khôi phục kết nối Topic cũ (Bảo trì dữ liệu) ─────────────────────
  tgBot.command('remap', (ctx) => {
    // 1. Lấy ID của Topic hiện tại mà người dùng đang gõ lệnh
    const topicId = ctx.message.message_thread_id;
    const text = ctx.message.text || '';
    const parts = text.split(' ');

    // 2. Kiểm tra xem lệnh có được gọi trong Topic không
    if (!topicId) {
      return ctx.reply('⚠️ Lệnh này phải được dùng bên trong một Topic cụ thể.').catch(() => undefined);
    }

    // 3. Lấy Zalo ID từ cú pháp lệnh
    const zaloId = parts[1];
    const typeStr = parts[2]; // Tham số loại: 1 (Nhóm) hoặc 0 (Cá nhân)

    if (!zaloId) {
      return ctx.reply(
        '⚠️ Vui lòng cung cấp Zalo ID để khôi phục kết nối.\\n\\n' +
        '<b>Cú pháp:</b> <code>/remap [Zalo_ID] [Loại]</code>\\n' +
        '<i>(Loại: 1 cho Nhóm, 0 cho Cá nhân. Mặc định là Nhóm)</i>\\n\\n' +
        '💡 <i>Mẹo: Dùng lệnh /search ở bên ngoài để tra cứu Zalo ID.</i>',
        { parse_mode: 'HTML' }
      ).catch(() => undefined);
    }

    // Đặt mặc định là Nhóm (1) nếu người dùng không nhập loại
    const type = typeStr === '0' ? 0 : 1;

    // 4. Lưu lại Mapping mới vào bộ nhớ (Store)
    store.set({
      topicId: topicId,
      zaloId: zaloId,
      type: type,
      name: "Khôi phục dữ liệu" // Tên sẽ tự được cập nhật lại khi có tin nhắn mới
    });

    // 5. Thông báo thành công
    return ctx.reply(
      `✅ <b>Khôi phục thành công!</b>\\nĐã nối Topic ID <code>${topicId}</code> với Zalo ID <code>${zaloId}</code>.\\nBây giờ bạn có thể nhắn tin bình thường từ Topic này.`,
      { parse_mode: 'HTML' }
    ).catch(() => undefined);
  });

  // ── Start Telegram bot so /login can be received immediately ───────────────
  tgBot.launch({ allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] }, () => {
    console.log('[Boot] Telegram bot started ✓');

    syncTelegramCommands()
      .then(() => console.log('[Boot] Telegram command menu synced ✓'))
      .catch((err: unknown) => console.warn('[Boot] Failed to sync Telegram commands:', err));

    // ── Attempt Zalo login in background with infinite retry ────────────────────────────────────
    // Never stop - keep retrying forever with exponential backoff
    if (!_initialLoginAttempted) {
      _initialLoginAttempted = true;
      void infiniteInitialLoginLoop();
    }
  });

  console.log('[Boot] Bridge is running 🚀  (Ctrl+C to stop)');

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\\n[Boot] Received ${signal}, shutting down...`);
    try { const api = await getZaloApi(); api.listener.stop(); } catch { /* ignore */ }
    await tgBot.stop(signal);
    await new Promise(r => setTimeout(r, 2500));
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
