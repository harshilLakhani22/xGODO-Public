import { FIREFOX_PACKAGE } from './config';

const FIREFOX_PACKAGE_CANDIDATES = [
  'org.mozilla.firefox',
  'org.mozilla.fenix',
  'org.mozilla.firefox_beta',
  'org.mozilla.fenix.beta',
  'org.mozilla.fenix.nightly',
];

let runtimeFirefoxPackage = FIREFOX_PACKAGE;

function normalizePackage(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function hasFirefoxSignature(pkg: string): boolean {
  const normalized = normalizePackage(pkg);
  if (!normalized.startsWith('org.mozilla')) return false;
  return normalized.includes('firefox') || normalized.includes('fenix');
}

function extractInstalledPackageNames(installedAppsRaw: unknown): string[] {
  if (Array.isArray(installedAppsRaw)) {
    return installedAppsRaw
      .map(app => {
        if (typeof app === 'string') return app;
        if (app && typeof app === 'object') {
          if (typeof (app as any).packageName === 'string') return (app as any).packageName;
          if (typeof (app as any).package === 'string') return (app as any).package;
          if (typeof (app as any).appId === 'string') return (app as any).appId;
        }
        return '';
      })
      .filter(Boolean);
  }

  if (installedAppsRaw && typeof installedAppsRaw === 'object') {
    const record = installedAppsRaw as Record<string, unknown>;
    const names = new Set<string>(Object.keys(record));
    Object.values(record).forEach(value => {
      if (!value || typeof value !== 'object') return;
      const entry = value as Record<string, unknown>;
      if (typeof entry.packageName === 'string') names.add(entry.packageName);
      if (typeof entry.package === 'string') names.add(entry.package);
      if (typeof entry.appId === 'string') names.add(entry.appId);
    });
    return [...names];
  }

  return [];
}

export function getInstalledPackageNamesPreview(installedAppsRaw: unknown, limit = 40): string[] {
  return extractInstalledPackageNames(installedAppsRaw).slice(0, Math.max(1, limit));
}

export function resolveFirefoxPackage(installedAppsRaw: unknown): string | null {
  const packageNames = extractInstalledPackageNames(installedAppsRaw);
  if (packageNames.length === 0) return null;

  const byLowerName = new Map<string, string>();
  packageNames.forEach(name => byLowerName.set(name.toLowerCase(), name));

  for (const candidate of FIREFOX_PACKAGE_CANDIDATES) {
    const match = byLowerName.get(candidate.toLowerCase());
    if (match) return match;
  }

  return packageNames.find(name => hasFirefoxSignature(name)) || null;
}

export function setFirefoxPackage(pkg: string): void {
  runtimeFirefoxPackage = pkg || FIREFOX_PACKAGE;
}

export function getFirefoxPackage(): string {
  return runtimeFirefoxPackage;
}

export function isFirefoxPackageName(pkg: unknown): boolean {
  const normalized = normalizePackage(pkg);
  if (!normalized) return false;

  if (normalized === normalizePackage(runtimeFirefoxPackage)) return true;
  return hasFirefoxSignature(normalized);
}
