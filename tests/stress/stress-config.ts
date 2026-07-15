import { join } from 'path';

export interface StressConfig {
  durationMinutes: number;
  concurrentSessions: number;
  messageTimeoutMs: number;
  mixedNewSessionIntervalMs: number;
  reportDir: string;
}

export function loadConfig(): StressConfig {
  return {
    durationMinutes: parseInt(process.env.STRESS_DURATION || '30', 10),
    concurrentSessions: parseInt(process.env.STRESS_CONCURRENT_SESSIONS || '3', 10),
    messageTimeoutMs: parseInt(process.env.STRESS_MSG_TIMEOUT || '120000', 10),
    mixedNewSessionIntervalMs: parseInt(process.env.STRESS_NEW_SESSION_INTERVAL || '120000', 10),
    reportDir: process.env.STRESS_REPORT_DIR || join(process.cwd(), 'tests/stress/reports'),
  };
}

export interface ScenarioTimeBudget {
  singleSessionMs: number;
  multiSessionMs: number;
  mixedModeMs: number;
}

export function computeTimeBudgets(config: StressConfig): ScenarioTimeBudget {
  const totalMs = config.durationMinutes * 60 * 1000;
  return {
    singleSessionMs: Math.floor(totalMs * 0.3),
    multiSessionMs: Math.floor(totalMs * 0.3),
    mixedModeMs: Math.floor(totalMs * 0.4),
  };
}
