// GET /api/config: the public settings the office page needs to sign people in.
import { config, missingSettings, json } from './_lib.js';

export function GET() {
  if (config.dev) return json({ dev: true, missing: [] });
  return json({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    missing: missingSettings(),
    dailyLimit: config.dailyLimit,
  });
}
