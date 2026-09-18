"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import CommandPalette from "./CommandPalette";
import { Wordmark } from "./ui";
import { IconChat, IconCompass, IconHome, IconLibrary, IconPlug, IconSearch, IconSettings } from "./icons";
import { api } from "@/lib/client/api";
import { useDataSignal, useResource } from "@/lib/client/store";

const NAV = [
  { href: "/", label: "Home", Icon: IconHome },
  { href: "/chat", label: "Chat", Icon: IconChat },
  { href: "/explore", label: "Explore", Icon: IconCompass },
  { href: "/library", label: "Library", Icon: IconLibrary },
];

/*
 * Money deliberately has no place in the navigation.
 *
 * Freebuff's own spec deletes the entire credits/subscription surface (its
 * `UsageBanner`, `OutOfCreditsBanner` and credits footer all render null) and
 * removes `/usage` and `/subscribe` outright — the product's whole promise is
 * that the user never sees the economics. The ledger, the ad serving and the
 * funding all still run; they are just not something you look at while you code.
 * `/economy` remains a working route for when you want the books.
 */
const ACTIONS = [
  { href: "/connections", label: "Connections", Icon: IconPlug },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

export default function TopNav() {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { data, refresh } = useResource(() => api.bootstrap(), [pathname]);
  // Only the Connections dot reads this now (is a key connected), so the 4s
  // money poll that used to keep the readout honest is gone with the readout.
  useDataSignal(refresh);

  // ⌘K / Ctrl-K from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40" style={{ paddingTop: "var(--nav-top)" }}>
        <div className="shell-inner">
          <div className="glass sheen drag flex h-[var(--nav-h)] items-center gap-2 rounded-full pl-3.5 pr-2.5">
            {/* Brand */}
            <Link href="/" className="no-drag flex items-center gap-2.5 rounded-full py-1 pr-2 transition-opacity hover:opacity-85">
              <Wordmark size={26} label={pathname === "/library" ? "Infyield" : "Infyield"} />
            </Link>

            {/* Primary navigation — a segmented control, not a sidebar */}
            <nav className="no-drag seg ml-1.5 hidden sm:inline-flex">
              {NAV.map(({ href, label, Icon }) => (
                <Link key={href} href={href} className="seg-item" data-active={isActive(href)} aria-label={label}>
                  <Icon size={14.5} className="sm:hidden md:block" />
                  <span className="hidden md:inline">{label}</span>
                </Link>
              ))}
            </nav>

            <div className="flex-1" />

            {/* Icon actions */}
            <div className="no-drag flex items-center gap-1">
              <button className="btn btn-quiet btn-sm gap-2" onClick={() => setPaletteOpen(true)} aria-label="Search">
                <IconSearch size={15} />
                <span className="hidden text-[12.5px] text-[var(--text-3)] lg:inline">Search</span>
                <kbd className="mono hidden rounded-md border border-[var(--border-2)] bg-[rgba(0,0,0,0.35)] px-1.5 py-0.5 text-[10px] text-[var(--text-3)] lg:inline">⌘K</kbd>
              </button>
              {ACTIONS.map(({ href, label, Icon }) => (
                <Link
                  key={href}
                  href={href}
                  title={label}
                  aria-label={label}
                  className={`btn btn-sm relative ${isActive(href) ? "btn-glass" : "btn-quiet"}`}
                >
                  <Icon size={15.5} />
                  {href === "/connections" && data && <span className={data.hasAnyKey ? "dot-live absolute right-1.5 top-1.5" : "dot-idle absolute right-1.5 top-1.5"} />}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
