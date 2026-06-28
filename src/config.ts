import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

function envFlag(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function optionalNumberEnv(...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const val = Number(raw);
    return Number.isFinite(val) ? val : undefined;
  }
  return undefined;
}

export const config = {
  telegram: {
    token:       requireEnv('TG_TOKEN'),
    groupId:     Number(requireEnv('TG_GROUP_ID')),
    group_notification_id: optionalNumberEnv('group_notification_id', 'GROUP_NOTIFICATION_ID'),
    /** URL của local Bot API server, ví dụ: http://localhost:8081.
     *  Chỉ dùng khi LOCAL_BOT_API=1 và TG_LOCAL_SERVER được set.
     *  Nếu không → dùng official api.telegram.org. */
    localServer: envFlag('LOCAL_BOT_API')
      ? (process.env.TG_LOCAL_SERVER?.replace(/\/$/, '') || null)
      : null,
  },
  zalo: {
    credentialsPath: resolvePath(process.env.ZALO_CREDENTIALS_PATH, 'credentials.json'),
    skipMutedGroups: envFlag('ZALO_SKIP_MUTED_GROUPS'),
    // Mirror Zalo's "mute notifications" → deliver those threads silently on
    // Telegram (messages still arrive, just no ping). On by default; set
    // ZALO_MUTE_SILENT=0 to always notify.
    muteSilentMirror: envFlag('ZALO_MUTE_SILENT', true),
  },
  dataDir: resolvePath(process.env.DATA_DIR, 'data'),
} as const;
