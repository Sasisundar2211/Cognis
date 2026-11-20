import { Link } from "react-router";
import { hostOf, relativeTime, sourceLabel, type Item } from "../lib/api";
import { Snippet } from "./Snippet";
import { SourceBadge, StatusBadge } from "./ui";

function preview(item: Item) {
  let text = item.description || item.content || item.extractedText;
  // Notes use their first line as the title; don't repeat it in the preview.
  if (!item.description && item.content && text.startsWith(item.title)) text = text.slice(item.title.length).trimStart();
  return text.slice(0, 240);
}

export function ItemRow({ item, snippet, reason }: { item: Item; snippet?: string; reason?: string }) {
  const host = hostOf(item.originalUrl);
  return (
    <li className="anim-rise">
      <Link
        to={`/app/items/${item.id}`}
        className="group block rounded-xl px-4 py-3.5 transition-colors duration-150 hover:bg-panel focus-visible:bg-panel"
      >
        <div className="flex items-center gap-2 text-[0.75rem] text-ink-2">
          <SourceBadge source={sourceLabel(item.sourcePlatform)} />
          {host && <span className="truncate">{host}</span>}
          <span aria-hidden="true">·</span>
          <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
            Saved {relativeTime(item.createdAt)}
          </time>
          <StatusBadge status={item.status} />
        </div>
        <h3 className="mt-1.5 line-clamp-2 text-[0.9375rem] font-semibold text-ink group-hover:text-primary">
          {item.title || host || "Untitled"}
        </h3>
        <p className="mt-1 line-clamp-2 max-w-[70ch] text-[0.875rem] text-ink-2">
          {snippet ? <Snippet text={snippet} /> : preview(item)}
        </p>
        {(reason || item.tags.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem]">
            {reason && <span className="text-primary-soft-ink">{reason}</span>}
            {item.tags.slice(0, 5).map((t) => (
              <span key={t} className="text-ink-2">
                #{t}
              </span>
            ))}
          </div>
        )}
      </Link>
    </li>
  );
}

export function ItemListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="grid gap-1">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-4 py-3.5">
          <div className="skeleton h-3 w-40" />
          <div className="skeleton mt-2.5 h-4 w-3/4" />
          <div className="skeleton mt-2 h-3 w-full max-w-xl" />
        </li>
      ))}
    </ul>
  );
}
