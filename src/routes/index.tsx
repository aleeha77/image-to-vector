import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-white px-6 text-center dark:bg-neutral-900">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-6 w-6 animate-pulse text-slate-400 dark:text-white/50"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </svg>
      <p className="text-sm font-medium text-slate-900 dark:text-white/80">
        Your site will appear here
      </p>
    </main>
  );
}
