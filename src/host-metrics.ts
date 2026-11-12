import fs from "node:fs";
import os from "node:os";

export interface HostMetricsSnapshot {
  cpuCurrentPercent: number;
  cpuAvg5mPercent: number;
  cpuCores: number;
  memUsedBytes: number;
  memTotalBytes: number;
  memUsedPercent: number;
  maxCpuAvg5mPercent: number;
  overloaded: boolean;
  updatedAt: string;
}

export interface HostMetricsProvider {
  getSnapshot(): HostMetricsSnapshot;
  stop(): void;
}

interface CpuTickSample {
  ts: number;
  total: number;
  idle: number;
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const SAMPLE_INTERVAL_MS = 2_000;

export const RESOURCE_BUSY_MESSAGE =
  "There are no free resources to connect right now. Please contact the demo owner for assistance.";

function round1(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function readProcCpuTicks(): { total: number; idle: number } | null {
  try {
    const stat = fs.readFileSync("/proc/stat", "utf8");
    const firstLine = stat.slice(0, stat.indexOf("\n"));
    if (!firstLine.startsWith("cpu ")) return null;
    const parts = firstLine.trim().split(/\s+/).slice(1).map((n) => Number.parseInt(n, 10));
    if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return null;
    // user, nice, system, idle, iowait, irq, softirq, steal (exclude guest/guest_nice already counted in user/nice)
    const count = Math.min(parts.length, 8);
    let total = 0;
    for (let i = 0; i < count; i++) {
      total += parts[i]!;
    }
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    return { total, idle };
  } catch {
    return null;
  }
}

function readOsCpuTicks(): { total: number; idle: number } {
  const cpus = os.cpus();
  let total = 0;
  let idle = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { total, idle };
}

function readHostMemory(): { usedBytes: number; totalBytes: number; usedPercent: number } {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
    let totalKb = 0;
    let availKb = -1;
    let freeKb = 0;
    let buffersKb = 0;
    let cachedKb = 0;

    for (const line of meminfo.split("\n")) {
      if (line.startsWith("MemTotal:")) {
        totalKb = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10);
      } else if (line.startsWith("MemAvailable:")) {
        availKb = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10);
      } else if (line.startsWith("MemFree:")) {
        freeKb = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10);
      } else if (line.startsWith("Buffers:")) {
        buffersKb = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10);
      } else if (line.startsWith("Cached:")) {
        cachedKb = Number.parseInt(line.split(/\s+/)[1] ?? "0", 10);
      }
    }

    if (totalKb > 0) {
      const effectiveAvailKb = availKb >= 0 ? availKb : freeKb + buffersKb + cachedKb;
      const usedKb = Math.max(0, totalKb - effectiveAvailKb);
      const totalBytes = totalKb * 1024;
      const usedBytes = usedKb * 1024;
      return {
        usedBytes,
        totalBytes,
        usedPercent: round1((usedKb / totalKb) * 100),
      };
    }
  } catch {
    // Fallback to node:os below
  }

  const totalBytes = os.totalmem();
  const usedBytes = Math.max(0, totalBytes - os.freemem());
  return {
    usedBytes,
    totalBytes,
    usedPercent: totalBytes > 0 ? round1((usedBytes / totalBytes) * 100) : 0,
  };
}

export class HostMetricsMonitor implements HostMetricsProvider {
  private readonly samples: CpuTickSample[] = [];
  private readonly cpuCores: number;
  private readonly bootLoad5mPercent: number;
  private currentCpuPercent: number;
  private avg5mCpuPercent: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly maxCpuAvg5mPercent = 70) {
    this.cpuCores = Math.max(1, os.cpus().length || 1);
    const [load1 = 0, load5 = 0] = os.loadavg();
    this.bootLoad5mPercent = round1(Math.min(100, (load5 / this.cpuCores) * 100));
    this.currentCpuPercent = round1(Math.min(100, (load1 / this.cpuCores) * 100));
    this.avg5mCpuPercent = this.bootLoad5mPercent;

    this.recordSample();
    this.timer = setInterval(() => {
      this.recordSample();
    }, SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  private recordSample(): void {
    const now = Date.now();
    const ticks = readProcCpuTicks() ?? readOsCpuTicks();

    const prev = this.samples.at(-1);
    if (prev && ticks.total > prev.total) {
      const dTotal = ticks.total - prev.total;
      const dIdle = Math.max(0, ticks.idle - prev.idle);
      const busyRatio = Math.max(0, dTotal - dIdle) / dTotal;
      this.currentCpuPercent = round1(busyRatio * 100);
    }

    this.samples.push({ ts: now, total: ticks.total, idle: ticks.idle });

    // Prune samples older than 5 minutes (keeping one anchor just before the 5m cutoff)
    const cutoff = now - FIVE_MINUTES_MS;
    while (this.samples.length > 2 && this.samples[1]!.ts <= cutoff) {
      this.samples.shift();
    }

    const oldest = this.samples[0]!;
    const windowMs = now - oldest.ts;
    if (windowMs > 0 && ticks.total > oldest.total) {
      const dTotal5m = ticks.total - oldest.total;
      const dIdle5m = Math.max(0, ticks.idle - oldest.idle);
      const statWindowPercent = (Math.max(0, dTotal5m - dIdle5m) / dTotal5m) * 100;

      if (windowMs >= FIVE_MINUTES_MS) {
        this.avg5mCpuPercent = round1(statWindowPercent);
      } else {
        // Blend exact /proc/stat ticks since server start with kernel 5m loadavg prior to boot
        const w = windowMs / FIVE_MINUTES_MS;
        this.avg5mCpuPercent = round1(w * statWindowPercent + (1 - w) * this.bootLoad5mPercent);
      }
    }
  }

  getSnapshot(): HostMetricsSnapshot {
    const mem = readHostMemory();
    const overloaded = this.avg5mCpuPercent >= this.maxCpuAvg5mPercent;
    return {
      cpuCurrentPercent: this.currentCpuPercent,
      cpuAvg5mPercent: this.avg5mCpuPercent,
      cpuCores: this.cpuCores,
      memUsedBytes: mem.usedBytes,
      memTotalBytes: mem.totalBytes,
      memUsedPercent: mem.usedPercent,
      maxCpuAvg5mPercent: this.maxCpuAvg5mPercent,
      overloaded,
      updatedAt: new Date().toISOString(),
    };
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
