import type { ReactElement } from 'react';

type ToolbarIconKey = 'trajectory' | 'road' | 'adjust' | 'record' | 'drive';

const iconProps = {
  width: 16,
  height: 16,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
};

export const TOOLBAR_ICONS: Record<ToolbarIconKey, ReactElement> = {
  trajectory: (
    <svg viewBox="0 0 24 24" {...iconProps}>
      <path d="M4 19c2.5-6 7.5-9 11-7" />
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  ),
  road: (
    <svg viewBox="0 0 24 24" {...iconProps}>
      <path d="M8 3h2l4 18h-2" />
      <path d="M4 21l4-18" />
      <path d="M12 3h4l-4 18h4" />
    </svg>
  ),
  adjust: (
    <svg viewBox="0 0 24 24" {...iconProps}>
      <path d="M4 20 17 7" />
      <path d="M14 4l6 6" />
      <path d="M3 10l7 7" />
    </svg>
  ),
  record: (
    <svg viewBox="0 0 24 24" {...iconProps}>
      <circle cx="12" cy="12" r="5" fill="currentColor" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  ),
  drive: (
    <svg viewBox="0 0 24 24" {...iconProps}>
      <circle cx="12" cy="12" r="8" />
      <path d="M6.5 9h11" />
      <path d="M9 16h6" />
      <circle cx="9" cy="13.5" r="1.2" />
      <circle cx="15" cy="13.5" r="1.2" />
    </svg>
  )
};
