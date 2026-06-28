export interface AppAction {
  label: string;
  icon: string | null;
  color: string;
}

export const APP_ACTIONS: Record<string, AppAction> = {
  "com.anthropic.claude": {
    label: "Paste into Claude",
    icon: "claude",
    color: "#D4A27F",
  },
  "com.openai.chat": {
    label: "Paste into ChatGPT",
    icon: "chatgpt",
    color: "#10A37F",
  },
  "com.todesktop.230313mzl4w4u90": {
    label: "Paste into Cursor",
    icon: "cursor",
    color: "#ffffff",
  },
  "com.microsoft.VSCode": {
    label: "Paste into VS Code",
    icon: "vscode",
    color: "#007ACC",
  },
  "com.figma.Desktop": {
    label: "Paste into Figma",
    icon: "figma",
    color: "#F24E1E",
  },
  "com.tinyspeck.slackmacgap": {
    label: "Paste into Slack",
    icon: "slack",
    color: "#4A154B",
  },
  "com.linear.app": {
    label: "Paste into Linear",
    icon: "linear",
    color: "#5E6AD2",
  },
  "notion.id": {
    label: "Paste into Notion",
    icon: "notion",
    color: "#ffffff",
  },
  "com.google.Chrome": {
    label: "Paste into Chrome",
    icon: "chrome",
    color: "#4285F4",
  },
  "com.apple.Safari": {
    label: "Paste into Safari",
    icon: "safari",
    color: "#006CFF",
  },
};

export function getAppAction(bundleId: string): AppAction {
  return (
    APP_ACTIONS[bundleId] ?? {
      label: "Copy to Clipboard",
      icon: null,
      color: "#888888",
    }
  );
}

// SVG icons as inline strings for apps
export const APP_ICONS: Record<string, string> = {
  claude: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="7" fill="#D97757"/><path d="M6.4 17.3l3.9-10.6h3.4l3.9 10.6h-2.8l-.8-2.4h-4l-.8 2.4H6.4Z" fill="#fff7ed"/><path d="M10.7 12.8h2.6L12 8.9l-1.3 3.9Z" fill="#D97757"/></svg>`,
  chatgpt: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="7" fill="#0FA47F"/><path d="M12 5.2c1.3 0 2.5.7 3.1 1.8 1.2.1 2.3.8 2.9 1.8.7 1.2.6 2.6 0 3.7.5 1.1.4 2.5-.3 3.5-.7 1.1-1.9 1.8-3.2 1.8-.8.9-2 1.4-3.3 1.4-1.3 0-2.5-.7-3.1-1.8-1.2-.1-2.3-.8-2.9-1.8-.7-1.2-.6-2.6 0-3.7-.5-1.1-.4-2.5.3-3.5.7-1.1 1.9-1.8 3.2-1.8.8-.9 2-1.4 3.3-1.4Z" stroke="white" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.9 6.9l6.1 3.5v4.8M17.9 12.6l-6.1 3.5-4.1-2.4M14.6 17.8v-7.1L10.6 8M6.2 11.5l6.1-3.5 4.1 2.4M9.4 6.4v7.1l4.1 2.6M6.3 14.6l6.1 3.5" stroke="white" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  vscode: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3l7.5 7.5L3 18l3 3 18-9L6 0 3 3z" fill="#007ACC"/></svg>`,
  figma: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="7" fill="#101114"/><path d="M12 12a3.2 3.2 0 1 1 3.2-3.2H12V12Z" fill="#FF7262"/><path d="M8.8 12H12v3.2A3.2 3.2 0 1 1 8.8 12Z" fill="#0ACF83"/><path d="M8.8 5.6A3.2 3.2 0 0 1 12 8.8V12H8.8a3.2 3.2 0 0 1 0-6.4Z" fill="#A259FF"/><path d="M12 12h3.2a3.2 3.2 0 1 1-3.2 3.2V12Z" fill="#1ABCFE"/><path d="M12 5.6h3.2a3.2 3.2 0 1 1 0 6.4H12V5.6Z" fill="#F24E1E"/></svg>`,
  slack: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#4A154B"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="white">S</text></svg>`,
  linear: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#5E6AD2"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="white">L</text></svg>`,
  notion: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#ffffff"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="black">N</text></svg>`,
  chrome: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#4285F4"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="white">C</text></svg>`,
  safari: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#006CFF"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="white">S</text></svg>`,
  cursor: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#1a1a1a"/><text x="12" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="white">⌥</text></svg>`,
};
