import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function BaseIcon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      {...props}
    />
  );
}

export function ProductMark(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M8 15.5V8.5h5" />
      <path d="m10.5 13 3-3 2.5 2.5L19 9.5" />
      <circle cx="8" cy="15.5" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="10" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="19" cy="9.5" r="0.75" fill="currentColor" stroke="none" />
    </BaseIcon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 3.5 3.5" />
    </BaseIcon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </BaseIcon>
  );
}

export function WorkspaceIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="4" y="5" width="16" height="14" rx="3" />
      <path d="M9 5v14" />
      <path d="M12.5 10h4" />
      <path d="M12.5 14h3" />
    </BaseIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m7 10 5 5 5-5" />
    </BaseIcon>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m14.5 7-5 5 5 5" />
    </BaseIcon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m9.5 7 5 5-5 5" />
    </BaseIcon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m7 7 10 10" />
      <path d="M17 7 7 17" />
    </BaseIcon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 18V6" />
      <path d="m7 11 5-5 5 5" />
    </BaseIcon>
  );
}

export function AttachmentIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M8.5 12.5 14 7a3 3 0 1 1 4.25 4.25l-7 7a5 5 0 0 1-7.07-7.07l7.25-7.25" />
    </BaseIcon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <rect x="9" y="4" width="6" height="11" rx="3" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0" />
      <path d="M12 17v3" />
    </BaseIcon>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M5 7h14" />
      <path d="M8 12h8" />
      <path d="M10.5 17h3" />
    </BaseIcon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a1.7 1.7 0 0 0 .03.32l1.54 1.2-1.5 2.6-1.87-.5a1.7 1.7 0 0 0-.28.17l-.27 1.91h-3l-.27-1.91a1.7 1.7 0 0 0-.28-.17l-1.87.5-1.5-2.6 1.54-1.2A1.7 1.7 0 0 0 5 12c0-.11.01-.21.03-.32l-1.54-1.2 1.5-2.6 1.87.5c.09-.06.18-.12.28-.17l.27-1.91h3l.27 1.91c.1.05.19.11.28.17l1.87-.5 1.5 2.6-1.54 1.2c.02.11.03.21.03.32Z" />
    </BaseIcon>
  );
}
