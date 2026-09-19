import type { SVGProps } from "react";

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

export function ArrowLeftIcon({ size = 16, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-arrow-left ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12.5 15.5L7 10l5.5-5.5" />
    </svg>
  );
}

export function HistoryBackIcon({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-history-back ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M7 5H3m0 0v4M3 5l4.5 4.5a6 6 0 1 1-1.3 6.3" />
    </svg>
  );
}

export function HistoryForwardIcon({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-history-forward ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M13 5h4m0 0v4m0-4l-4.5 4.5a6 6 0 1 0 1.3 6.3" />
    </svg>
  );
}

export function MenuHamburgerIcon({ size = 19, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-menu ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <line x1="3.5" y1="5.5" x2="16.5" y2="5.5" />
      <line x1="3.5" y1="10" x2="16.5" y2="10" />
      <line x1="3.5" y1="14.5" x2="16.5" y2="14.5" />
    </svg>
  );
}

export function BookmarkIcon({ size = 16, active = false, className = "", ...props }: IconProps & { active?: boolean }) {
  return (
    <svg
      className={`reader-svg-icon icon-bookmark ${active ? "is-active" : ""} ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5.5 3.2A1.7 1.7 0 0 1 7.2 1.5h5.6a1.7 1.7 0 0 1 1.7 1.7v14.6a.6.6 0 0 1-.95.49L10 15.3l-3.55 2.49a.6.6 0 0 1-.95-.49V3.2z" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 13, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M6 8l4 4 4-4" />
    </svg>
  );
}

export function ChevronRightIcon({ size = 13, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M7.5 5.5L12 10l-4.5 4.5" />
    </svg>
  );
}

export function BookOpenIcon({ size = 19, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-toc ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M2.5 4.5A2 2 0 0 1 4.5 2.5H9v14H4.5A2 2 0 0 0 2.5 18.5V4.5zM17.5 4.5A2 2 0 0 0 15.5 2.5H11v14h4.5a2 2 0 0 1 2 2V4.5z" />
    </svg>
  );
}

export function SearchIcon({ size = 19, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-search ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.2 13.2L17.5 17.5" />
    </svg>
  );
}

export function PencilIcon({ size = 19, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-notes ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M13.5 2.5l3.5 3.5L6.5 16.5H3v-3.5L13.5 2.5z" />
    </svg>
  );
}

export function SparklesIcon({ size = 19, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-ai ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M10 2l1.6 3.8L15.5 7.5l-3.9 1.7L10 13l-1.6-3.8L4.5 7.5l3.9-1.7L10 2zM15 12.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8.8-1.9z" />
    </svg>
  );
}

export function WrenchIcon({ size = 18, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-wrench ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12.5 3.5a4 4 0 0 0-4.7 4.7L3.5 12.5a2 2 0 1 0 2.8 2.8l4.3-4.3a4 4 0 0 0 4.7-4.7l-2.4 2.4-2.8-.4-.4-2.8 2.8-2.7z" />
    </svg>
  );
}

export function PinIcon({ size = 15, pinned = false, className = "", ...props }: IconProps & { pinned?: boolean }) {
  return (
    <svg
      className={`reader-svg-icon icon-pin ${pinned ? "is-pinned" : ""} ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill={pinned ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 3l5 5-1.8 1.8-1.4-1.4-3.8 3.8.3 3.6-1.6 1.6-1.5-3.1-3.1-1.5 1.6-1.6 3.6.3 3.8-3.8-1.4-1.4L12 3z" />
      <path d="M4 16l2.8-2.8" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-close ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <line x1="5.5" y1="5.5" x2="14.5" y2="14.5" />
      <line x1="14.5" y1="5.5" x2="5.5" y2="14.5" />
    </svg>
  );
}

export function MinusIcon({ size = 14, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <line x1="4.5" y1="10" x2="15.5" y2="10" />
    </svg>
  );
}

export function PlusIcon({ size = 14, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <line x1="10" y1="4.5" x2="10" y2="15.5" />
      <line x1="4.5" y1="10" x2="15.5" y2="10" />
    </svg>
  );
}

export function RotateCcwIcon({ size = 14, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 5v4h4" />
      <path d="M3.5 14.5a7 7 0 1 0 1.2-8L3 9" />
    </svg>
  );
}

export function WarningCircleIcon({ size = 14, className = "", ...props }: IconProps) {
  return (
    <svg
      className={`reader-svg-icon icon-warning ${className}`.trim()}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="10" cy="10" r="7.5" />
      <line x1="10" y1="6.5" x2="10" y2="10.5" />
      <circle cx="10" cy="13.5" r="0.75" fill="currentColor" />
    </svg>
  );
}
