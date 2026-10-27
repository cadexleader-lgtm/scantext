import type { ReactNode } from "react";
import { Camera, FolderOpen, Home, Settings } from "lucide-react";
import { APP_NAME } from "../config";
import { navigate, paths, useRoute } from "../lib/router";
import { cn } from "./ui/cn";

const items = [
  { key: "home", label: "Accueil", icon: Home, path: paths.home() },
  { key: "scan", label: "Nouveau scan", icon: Camera, path: paths.newScan() },
  { key: "documents", label: "Mes documents", icon: FolderOpen, path: paths.documents() },
  { key: "settings", label: "Paramètres", icon: Settings, path: paths.settings() },
] as const;

function activeKey(name: string): string {
  if (name === "home") return "home";
  if (name === "documents" || name === "doc" || name === "editor" || name === "page") return "documents";
  if (name === "settings") return "settings";
  return "";
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <img src="./favicon.svg" alt="" className="size-8" />
      {APP_NAME}
    </span>
  );
}

export function AppShell({ children, mobileNav = true }: { children: ReactNode; mobileNav?: boolean }) {
  const route = useRoute();
  const active = activeKey(route.name);
  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-line bg-white px-3 py-5 lg:flex" aria-label="Navigation principale">
        <a href="#/" className="mb-6 px-3 text-xl text-brand-900">
          <Logo />
        </a>
        <nav className="flex flex-col gap-1">
          {items.map((it) => (
            <a
              key={it.key}
              href={`#${it.path}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(it.path);
              }}
              aria-current={active === it.key ? "page" : undefined}
              className={cn(
                "flex h-11 items-center gap-3 rounded-xl px-3 font-medium transition-colors",
                active === it.key ? "bg-brand-50 text-brand-800" : "text-slate-700 hover:bg-slate-100",
              )}
            >
              <it.icon className="size-5" aria-hidden />
              {it.label}
            </a>
          ))}
        </nav>
        <p className="mt-auto px-3 text-xs leading-relaxed text-muted">
          Vos documents restent sur cet appareil. Le texte est reconnu localement, sans envoi à un serveur.
        </p>
      </aside>

      <div className={cn(mobileNav && "pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0")}>{children}</div>

      {mobileNav && (
        <nav
          aria-label="Navigation principale"
          className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-white/95 lg:hidden"
        >
          {items.map((it) => (
            <a
              key={it.key}
              href={`#${it.path}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(it.path);
              }}
              aria-current={active === it.key ? "page" : undefined}
              className={cn(
                "flex h-[4.5rem] flex-col items-center justify-center gap-0.5 text-[12px] font-medium",
                active === it.key ? "text-brand-700" : "text-slate-600",
              )}
            >
              {it.key === "scan" ? (
                <span className="flex size-9 items-center justify-center rounded-full bg-brand-700 text-white shadow">
                  <it.icon className="size-5" aria-hidden />
                </span>
              ) : (
                <span className="flex size-9 items-center justify-center">
                  <it.icon className="size-6" aria-hidden />
                </span>
              )}
              {it.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

/** En-tête de page (titre + actions), sticky. */
export function PageHeader({ title, back, actions, subtitle }: { title: ReactNode; back?: ReactNode; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <header className="safe-top sticky top-0 z-20 border-b border-line bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex min-h-16 max-w-5xl items-center gap-2 px-3 py-2 sm:px-5">
        {back}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold sm:text-xl">{title}</h1>
          {subtitle && <div className="truncate text-sm text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </header>
  );
}
