import React from "react";

const URL_REGEX = /((?:https?:\/\/|www\.)[^\s<]+)/gi;

function normalizeHref(url: string) {
  if (url.startsWith("www.")) return `https://${url}`;
  return url;
}

function splitTrailingPunctuation(url: string) {
  // Remove common trailing punctuation that often follows URLs in sentences.
  // Example: "https://a.com)." -> url="https://a.com", trailing=")."
  const match = url.match(/^(.*?)([\)\]\}\.,!?;:]+)$/);
  if (!match) return { url, trailing: "" };
  return { url: match[1], trailing: match[2] };
}

export function LinkifiedText({
  text,
  linkClassName,
}: {
  text: string;
  linkClassName?: string;
}) {
  if (!text) return null;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_REGEX)) {
    const raw = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      parts.push(text.slice(lastIndex, index));
    }

    const { url, trailing } = splitTrailingPunctuation(raw);
    const href = normalizeHref(url);

    parts.push(
      <a
        key={`${index}-${raw}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={
          linkClassName ??
          "underline underline-offset-2 decoration-current text-inherit hover:opacity-90"
        }
      >
        {url}
      </a>
    );

    if (trailing) parts.push(trailing);

    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}
