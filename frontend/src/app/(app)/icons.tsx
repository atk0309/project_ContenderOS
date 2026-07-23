// Line icons for the shell, traced from the Claude design (docs/design/Contender.dc.html). 24×24
// viewBox, currentColor stroke — colour comes from the consuming nav item (a token, never a literal).
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const WorkspaceIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M11 4v16" />
  </Svg>
);
export const GatekeeperIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);
export const DiffIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.4" />
    <circle cx="18" cy="18" r="2.4" />
    <path d="M6 8.5V15a3 3 0 0 0 3 3h6M18 15.5V9a3 3 0 0 0-3-3H9" />
  </Svg>
);
export const TrackerIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="5" height="16" rx="1.4" />
    <rect x="10" y="4" width="5" height="11" rx="1.4" />
    <rect x="17" y="4" width="4" height="14" rx="1.4" />
  </Svg>
);
export const MasterIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
  </Svg>
);
export const AdminIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="2.2" />
    <path d="M12 2l1.4 2.9 3.2.5-2.3 2.2.5 3.2L12 11.4 9.5 13l.5-3.2L7.7 7.6l3.2-.5z" />
    <path d="M5 21c0-3 3.1-5 7-5s7 2 7 5" />
  </Svg>
);
export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
  </Svg>
);
export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
  </Svg>
);
