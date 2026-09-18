import type { ReactNode, SVGProps } from "react";

/**
 * One icon system: 24px grid, 1.6px stroke, round caps and joins,
 * currentColor, no fills. Everything in the product draws from these so
 * nothing looks borrowed from somewhere else.
 */
export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function Glyph({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 10.6 12 4l8 6.6" />
    <path d="M6.2 9.9V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V9.9" />
  </Glyph>
);

export const IconChat = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M20 12.2c0 3.9-3.6 7-8 7a9.3 9.3 0 0 1-2.4-.3L5 20.5l1.3-3.2A6.6 6.6 0 0 1 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />
  </Glyph>
);

export const IconCompass = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M14.8 9.2l-1.6 4.2-4.2 1.6 1.6-4.2z" />
  </Glyph>
);

export const IconLibrary = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.6" y="6.4" width="6" height="13" rx="1.4" />
    <rect x="10.5" y="3.6" width="6" height="15.8" rx="1.4" />
    <path d="M19.4 6.6l1.9 12.4" />
  </Glyph>
);

export const IconSearch = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="11" cy="11" r="6.4" />
    <path d="M15.8 15.8 20.5 20.5" />
  </Glyph>
);

export const IconSettings = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="2.9" />
    <path d="M12 3.4v2.1M12 18.5v2.1M4.9 7.9l1.8 1M17.3 15.1l1.8 1M4.9 16.1l1.8-1M17.3 8.9l1.8-1" />
  </Glyph>
);

export const IconPlug = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M9.2 3.8v4.1M14.8 3.8v4.1" />
    <path d="M6.6 7.9h10.8v3.3a5.4 5.4 0 0 1-10.8 0z" />
    <path d="M12 16.6v3.6" />
  </Glyph>
);

export const IconWallet = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="3.6" y="6.2" width="16.8" height="12.4" rx="2.4" />
    <path d="M3.6 10.4h16.8" />
    <path d="M16.4 14.6h1.6" />
  </Glyph>
);

export const IconSparkle = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 4.2l1.7 4.6 4.6 1.7-4.6 1.7L12 16.8l-1.7-4.6L5.7 10.5l4.6-1.7z" />
  </Glyph>
);

export const IconBolt = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M13.4 3.6 6.2 13.1h4.4l-1 7.3 7.2-9.5h-4.4z" />
  </Glyph>
);

export const IconArrowRight = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5.2 12h13" />
    <path d="M13.4 7.2 18.2 12l-4.8 4.8" />
  </Glyph>
);

export const IconArrowUpRight = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7.6 16.4 16.4 7.6" />
    <path d="M9.4 7.6h7v7" />
  </Glyph>
);

export const IconPlus = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 5.6v12.8M5.6 12h12.8" />
  </Glyph>
);

export const IconCheck = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5.4 12.6l4.2 4.2 9-9.6" />
  </Glyph>
);

export const IconClose = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M6.6 6.6l10.8 10.8M17.4 6.6 6.6 17.4" />
  </Glyph>
);

export const IconTrash = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.8 7.4h14.4" />
    <path d="M9.4 7.4V5.8a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.6" />
    <path d="M6.6 7.4l.8 11a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.8-11" />
  </Glyph>
);

export const IconFolder = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.6 7.6a1.6 1.6 0 0 1 1.6-1.6h3.4l1.8 2.2h8.4a1.6 1.6 0 0 1 1.6 1.6v7.6a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z" />
  </Glyph>
);

export const IconFile = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M13.6 3.8H7.2a1.6 1.6 0 0 0-1.6 1.6v13.2a1.6 1.6 0 0 0 1.6 1.6h9.6a1.6 1.6 0 0 0 1.6-1.6V8.6z" />
    <path d="M13.4 3.9v4.6h4.8" />
  </Glyph>
);

export const IconLock = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="5.2" y="10.4" width="13.6" height="9.4" rx="2" />
    <path d="M8.6 10.4V8.2a3.4 3.4 0 0 1 6.8 0v2.2" />
  </Glyph>
);

export const IconRefresh = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M19.4 12a7.4 7.4 0 1 1-2.3-5.3" />
    <path d="M19.8 4.6v4.2h-4.2" />
  </Glyph>
);

export const IconWarn = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 4.6 21 19.4H3z" />
    <path d="M12 10v4M12 16.8v.2" />
  </Glyph>
);

export const IconLayers = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 3.8 3.8 8.2 12 12.6l8.2-4.4z" />
    <path d="M3.8 12.6 12 17l8.2-4.4" />
    <path d="M3.8 16.8 12 21.2l8.2-4.4" />
  </Glyph>
);

export const IconExternal = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M13.4 4.6h6v6" />
    <path d="M19.4 4.6 11.6 12.4" />
    <path d="M18 14.4v4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.6A1.6 1.6 0 0 1 5.6 6h4" />
  </Glyph>
);

export const IconPaperclip = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M20 11.4l-7.6 7.6a4.6 4.6 0 0 1-6.5-6.5l7.6-7.6a3 3 0 0 1 4.3 4.3l-7.6 7.6a1.5 1.5 0 0 1-2.1-2.1l7-7" />
  </Glyph>
);

export const IconInvoice = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M6 3.6h9.2L19 7.4V20a.9.9 0 0 1-.9.9H6a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1Z" />
    <path d="M14.6 3.8v3.8h3.9" />
    <path d="M8.4 11.6h7" />
    <path d="M8.4 15h4.4" />
  </Glyph>
);

export const IconClock = (p: IconProps) => (
  <Glyph {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.6V12l3.2 2" />
  </Glyph>
);
